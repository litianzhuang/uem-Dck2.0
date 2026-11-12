"""Focused policy tests; these use a fake Docker CLI, not a running Engine."""
import json
import unittest

import shared_engine_broker as broker

A = 1001
B = 1002
CID = "a" * 64
IMAGE = "registry.example.org/uem/python@sha256:" + "f" * 64
CATALOG = {"python": {"id": "python", "label": "Python", "image": IMAGE,
                      "memory": "8g", "pids": 512, "gpu": False}}


class FakeDocker:
    def __init__(self):
        self.calls = []
        self.volumes = set()
        self.owner = A
        self.workspace = "demo"
        self.running = False
        self.existing_names = []
        self.created = False

    def __call__(self, args, timeout=40):
        self.calls.append(list(args))
        if args[:2] == ["volume", "ls"]:
            return "\n".join(sorted(self.volumes)) + "\n"
        if args[:2] == ["volume", "create"]:
            self.volumes.add(args[-1])
            return args[-1] + "\n"
        if args[:2] == ["volume", "inspect"]:
            name = args[-1]
            return json.dumps([{"Name": name, "Labels": {"uem.managed": "1",
                              "uem.owner": str(self.owner)}}])
        if args[:2] == ["container", "inspect"]:
            vol = f"uem-u{self.owner}-ws-{self.workspace}"
            return json.dumps([{"Id": CID, "Name": f"/uem-u{self.owner}-env",
                                "Config": {"Labels": {"uem.owner": str(self.owner),
                                          "uem.managed": "1", "uem.workspace": self.workspace},
                                           "Image": IMAGE},
                                "State": {"Status": "running" if self.running else "created"},
                                "Mounts": [{"Destination": "/workspace", "Type": "volume",
                                            "Name": vol}]}])
        if args[:3] == ["container", "ls", "-a"]:
            if "--filter" in args:
                return CID + "\n" if f"label=uem.owner={self.owner}" in args else ""
            return "\n".join(self.existing_names) + "\n"
        if args[:2] == ["container", "ls"]:
            if "volume=" in " ".join(args):
                return CID + "\n" if self.running else ""
            return ""
        if args[:2] == ["image", "inspect"]:
            return "{}\n"
        if args[:2] == ["image", "pull"]:
            return "pulled\n"
        if args[:2] == ["container", "create"]:
            self.created = True
            return CID + "\n"
        if args[:2] == ["container", "logs"]:
            return "private user log\n"
        if args[:2] in (["container", "stop"], ["container", "start"],
                        ["container", "rm"]):
            return CID + "\n"
        if args[:1] == ["version"]:
            return "29.1\n"
        raise AssertionError("unexpected docker call: " + repr(args))


class BrokerPolicyTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeDocker()
        self.engine = broker.Engine(self.fake, catalog_loader=lambda: CATALOG)

    def test_declines_arbitrary_docker_commands_and_client_supplied_uid(self):
        for request in [
            {"action": "docker", "argv": ["ps"]},
            {"action": "list", "uid": B},
            {"action": "create", "name": "abc", "workspace": "demo",
             "profile": "python", "host_mount": "/etc"},
            {"action": "start", "container": CID, "privileged": True},
            {"action": "exec", "container": CID, "argv": ["sh"]},
        ]:
            with self.subTest(request=request), self.assertRaises(broker.Refused):
                self.engine.execute(A, request)
        self.assertFalse(self.fake.calls)

    def test_owner_is_checked_on_every_action(self):
        self.fake.owner = B
        self.fake.volumes.add(f"uem-u{B}-ws-demo")
        for action in ("inspect", "start", "stop", "remove", "logs"):
            with self.subTest(action=action), self.assertRaises(broker.Refused):
                self.engine.execute(A, {"action": action, "container": CID})
        self.assertFalse(any(call[:2] in [["container", a] for a in
                          ("start", "stop", "rm", "logs")] for call in self.fake.calls))

    def test_create_uses_only_fixed_safe_parameters_and_user_scoped_volume(self):
        answer = self.engine.execute(A, {"action": "create", "name": "env",
                                         "workspace": "demo", "profile": "python"})
        self.assertEqual(answer["id"], CID)
        self.assertIn("uem-u1001-ws-demo", self.fake.volumes)
        create = next(call for call in self.fake.calls if call[:2] == ["container", "create"])
        self.assertEqual(create[create.index("--name") + 1], "uem-u1001-env")
        self.assertEqual(create[create.index("--cap-drop") + 1], "ALL")
        self.assertIn("no-new-privileges", create)
        self.assertIn("--pull=never", create)
        self.assertNotIn("--privileged", create)
        self.assertNotIn("--pid", create)
        self.assertNotIn("-v", create)
        self.assertNotIn("--publish", create)
        self.assertNotIn("--gpus", create)
        self.assertIn("type=volume,source=uem-u1001-ws-demo,target=/workspace", create)

    def test_busy_workspace_refused_before_create(self):
        self.fake.volumes.add("uem-u1001-ws-demo")
        self.fake.running = True
        with self.assertRaisesRegex(broker.Refused, "WORKSPACE_IN_USE"):
            self.engine.execute(A, {"action": "create", "name": "env",
                                    "workspace": "demo", "profile": "python"})
        self.assertFalse(self.fake.created)

    def test_volumes_and_list_do_not_return_other_member_data(self):
        self.fake.volumes.update(["uem-u1001-ws-demo", "uem-u1002-ws-secret"])
        workspaces = self.engine.execute(A, {"action": "workspaces"})
        self.assertEqual(workspaces, {"workspaces": ["demo"]})
        listed = self.engine.execute(A, {"action": "list"})
        self.assertEqual(len(listed["containers"]), 1)
        self.assertEqual(listed["containers"][0]["id"], CID)

    def test_delete_never_deletes_volume(self):
        self.fake.volumes.add("uem-u1001-ws-demo")
        result = self.engine.execute(A, {"action": "remove", "container": CID})
        self.assertTrue(result["data_preserved"])
        self.assertFalse(any(call[0] == "volume" and call[1] in ("rm", "prune")
                             for call in self.fake.calls))

    def test_image_pull_limited_to_admin_profile(self):
        with self.assertRaises(broker.Refused):
            self.engine.execute(A, {"action": "pull", "profile": "../evil"})
        self.assertEqual(
            self.engine.execute(A, {"action": "pull", "profile": "python"})["pulled"],
            IMAGE)

    def test_raw_ids_and_names_are_strict(self):
        for value in ("abc", "../secret", "a" * 63, "b" * 65):
            with self.assertRaises(broker.Refused):
                broker.identifier(value)
        for value in ("-flag", "../x", "CamelCase", "/host/dir"):
            with self.assertRaises(broker.Refused):
                broker.slug(value)


if __name__ == "__main__":
    unittest.main()
