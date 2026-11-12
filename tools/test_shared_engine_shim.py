"""Contract tests for unprivileged 106-Docker Cockpit compatibility shim."""
import unittest

import member_docker
from shared_engine_client import RequestError

CID = "f" * 64


class ShimTests(unittest.TestCase):
    def test_status_has_existing_preflight_shape(self):
        def call(action, values):
            self.assertEqual((action, values), ("status", []))
            return {"ready": True, "mode": "shared-engine"}
        data = member_docker.handle("status", [], call)
        self.assertEqual(data["status"], "PASS")
        self.assertEqual(data["preflight"]["status"], "PASS")
        self.assertEqual(data["mode"], "shared-engine")

    def test_create_reorders_existing_ui_arguments_without_uid(self):
        called = []
        def call(action, values):
            called.append((action, values))
            return {"id": CID}
        result = member_docker.handle("create", ["env", "python", "demo"], call)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["environment"]["id"], CID)
        self.assertEqual(called, [("create", ["python", "env", "demo"])])

    def test_custom_images_are_blocked_not_trusted(self):
        def fail(*_):
            self.fail("should not contact broker")
        with self.assertRaisesRegex(RequestError, "UNSUPPORTED_CUSTOM_IMAGE"):
            member_docker.handle("create", ["env", "member-custom", "demo", "arbitrary/repo:tag"], fail)

    def test_create_conflict_maps_to_legacy_frontend_error(self):
        def fail(action, values):
            raise RequestError("WORKSPACE_IN_USE")
        result = member_docker.handle("create", ["env", "python", "demo"], fail)
        self.assertEqual(result, {"action": "create", "status": "BLOCKED",
                                  "code": "WORKSPACE_BUSY"})

    def test_start_uses_only_one_container_id(self):
        calls = []
        def call(action, values):
            calls.append((action, values))
            return {"result": "ok"}
        result = member_docker.handle("start", [CID], call)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(calls, [("start", [CID])])
        with self.assertRaises(RequestError):
            member_docker.handle("start", [CID, "extra"], call)

    def test_list_still_renders_original_state_and_status(self):
        def call(action, values):
            return {"containers": [{"id": CID, "state": "created", "name": "env"}]}
        result = member_docker.handle("list", [], call)
        self.assertEqual(result["containers"][0]["status"], "created")

    def test_missing_jupyter_terminal_and_snapshots_fail_closed(self):
        def fail(*_):
            self.fail("should not contact broker")
        for action in ("terminal", "jupyter-start", "snapshot", "restore", "snapshots"):
            with self.subTest(action=action), self.assertRaises(RequestError):
                member_docker.handle(action, [], fail)


if __name__ == "__main__":
    unittest.main()
