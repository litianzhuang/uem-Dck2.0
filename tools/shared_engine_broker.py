#!/usr/bin/env python3
"""Experimental root-owned broker for one shared Docker Engine.

Not production-accepted. No arbitrary Docker CLI, bind mount, container exec,
terminal attachment or user-selected UID is available through this protocol.
Do not expose this service over TCP or deploy to the production workstation.
"""
from __future__ import annotations

import grp
import json
import logging
import os
import pwd
import re
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

SOCKET = "/run/uem-shared-engine/broker.sock"
ENGINE_HOST = "unix:///var/run/docker.sock"
MEMBER_GROUP = "uem-docker-members"
CATALOG = Path("/etc/uem/docker-images.json")
MAX_REQUEST = 8192
MAX_RESPONSE = 1024 * 1024
MAX_LOGS = 128 * 1024
CID = re.compile(r"[0-9a-f]{64}\Z")
SLUG = re.compile(r"[a-z][a-z0-9-]{0,39}\Z")
IMAGE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,250}\Z")
DIGEST = re.compile(r"@sha256:[0-9a-f]{64}\Z")
LOGGER = logging.getLogger("uem-shared-engine")


class Refused(Exception):
    """Controlled refusal without leaking Docker stderr or host state."""


def slug(value):
    if not isinstance(value, str) or not SLUG.fullmatch(value):
        raise Refused("INVALID_NAME")
    return value


def identifier(value):
    if not isinstance(value, str) or not CID.fullmatch(value):
        raise Refused("INVALID_CONTAINER_ID")
    return value


def owner_volume(uid, workspace):
    return f"uem-u{uid}-ws-{slug(workspace)}"


def member_allowed(uid):
    """Recheck current OS account and supplementary group, not client JSON."""
    if not isinstance(uid, int) or uid < 1000:
        return False
    try:
        user = pwd.getpwuid(uid)
        group = grp.getgrnam(MEMBER_GROUP)
        if group.gr_gid not in os.getgrouplist(user.pw_name, user.pw_gid):
            return False
        # A newly disabled password / expired account must not receive new
        # broker requests, even if the old process retains Unix socket access.
        import spwd
        shadow = spwd.getspnam(user.pw_name)
        if shadow.sp_pwdp.startswith("!") or (shadow.sp_expire >= 0 and shadow.sp_expire < int(time.time() // 86400)):
            return False
        return True
    except (KeyError, OSError, PermissionError):
        return False


def read_catalog(path=CATALOG):
    """Read only root-owned admin templates; reject mutable/tagged images."""
    parent = path.parent
    ps = parent.stat()
    if ps.st_uid != 0 or ps.st_mode & 0o022 or not stat.S_ISDIR(ps.st_mode):
        raise Refused("CATALOG_DIRECTORY_UNSAFE")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022 or meta.st_size > 65536:
            raise Refused("CATALOG_UNSAFE")
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            fd = -1
            obj = json.load(stream)
    except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise Refused("CATALOG_INVALID") from exc
    finally:
        if fd >= 0:
            os.close(fd)
    if not isinstance(obj, dict) or obj.get("schema_version") != 1 or not isinstance(obj.get("profiles"), list):
        raise Refused("CATALOG_INVALID")
    result = {}
    for p in obj["profiles"]:
        if not isinstance(p, dict):
            raise Refused("CATALOG_INVALID")
        name = slug(p.get("id"))
        image = p.get("image")
        if (not isinstance(image, str) or not IMAGE.fullmatch(image)
                or not DIGEST.search(image)):
            raise Refused("CATALOG_IMAGE_NOT_PINNED")
        memory = p.get("memory", "8g")
        if memory not in {"2g", "4g", "8g", "16g", "32g", "48g"}:
            raise Refused("CATALOG_MEMORY_INVALID")
        pids = p.get("pids", 512)
        if type(pids) is not int or not 1 <= pids <= 1024 or type(p.get("gpu", False)) is not bool:
            raise Refused("CATALOG_LIMIT_INVALID")
        if p.get("network", "bridge") != "bridge":
            raise Refused("CATALOG_NETWORK_INVALID")
        if name in result:
            raise Refused("CATALOG_DUPLICATE_ID")
        result[name] = {"id": name, "label": str(p.get("label", name))[:100],
                        "image": image, "memory": memory, "pids": pids,
                        "gpu": p.get("gpu", False)}
    return result


class DockerRunner:
    def __call__(self, args, timeout=40):
        if not all(isinstance(x, str) for x in args):
            raise Refused("INVALID_DOCKER_ARGUMENT")
        env = {"PATH": "/usr/bin:/bin", "HOME": "/root", "LC_ALL": "C",
               "DOCKER_CONFIG": "/run/uem-shared-engine/docker-config"}
        try:
            with tempfile.SpooledTemporaryFile(max_size=MAX_RESPONSE, mode="w+b") as output:
                finished = subprocess.run(
                    ["/usr/bin/docker", "--host", ENGINE_HOST, *args], shell=False,
                    stdout=output, stderr=subprocess.DEVNULL,
                    timeout=timeout, env=env, check=False,
                )
                if finished.returncode != 0:
                    raise Refused("DOCKER_FAILED")
                output.seek(0, os.SEEK_END)
                if output.tell() > MAX_RESPONSE:
                    raise Refused("DOCKER_RESPONSE_TOO_LARGE")
                output.seek(0)
                return output.read().decode("utf-8", "replace")
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Refused("DOCKER_UNAVAILABLE") from exc


class Engine:
    def __init__(self, runner=None, catalog_loader=None):
        self.run = runner or DockerRunner()
        self.catalog_loader = catalog_loader or read_catalog
        self.lock = threading.RLock()

    def _container(self, uid, cid):
        cid = identifier(cid)
        info = json.loads(self.run(["container", "inspect", cid]))[0]
        labels = (info.get("Config") or {}).get("Labels") or {}
        if (info.get("Id") != cid or labels.get("uem.managed") != "1"
                or labels.get("uem.owner") != str(uid)):
            raise Refused("NOT_FOUND")
        workspace = labels.get("uem.workspace")
        if not isinstance(workspace, str):
            raise Refused("UNTRUSTED_CONTAINER")
        self._volume(uid, owner_volume(uid, workspace))
        mounts = [m for m in info.get("Mounts", []) if m.get("Destination") == "/workspace"]
        if len(mounts) != 1 or mounts[0].get("Type") != "volume" or mounts[0].get("Name") != owner_volume(uid, workspace):
            raise Refused("UNTRUSTED_MOUNT")
        return info

    def _volume(self, uid, name):
        if not isinstance(name, str) or not name.startswith(f"uem-u{uid}-ws-"):
            raise Refused("NOT_FOUND")
        info = json.loads(self.run(["volume", "inspect", name]))[0]
        labels = info.get("Labels") or {}
        if (info.get("Name") != name or labels.get("uem.managed") != "1"
                or labels.get("uem.owner") != str(uid)):
            raise Refused("NOT_FOUND")
        return info

    def _volume_exists(self, name):
        values = self.run(["volume", "ls", "--format", "{{.Name}}"]).splitlines()
        return name in values

    def _ensure_volume(self, uid, workspace):
        name = owner_volume(uid, workspace)
        if not self._volume_exists(name):
            self.run(["volume", "create", "--label", "uem.managed=1",
                      "--label", f"uem.owner={uid}", name])
        self._volume(uid, name)
        return name

    def _workspaces_in_use(self, volume):
        # Fail closed for ANY running holder, even if its labels are missing.
        return bool(self.run(["container", "ls", "--filter", "volume=" + volume,
                              "--format", "{{.ID}}"]).strip())

    def execute(self, uid, request):
        if type(uid) is not int or uid < 1000 or not isinstance(request, dict):
            raise Refused("UNAUTHORIZED")
        action = request.get("action")
        fields = {
            "status": {"action"}, "profiles": {"action"},
            "list": {"action"}, "workspaces": {"action"},
            "pull": {"action", "profile"},
            "create": {"action", "profile", "name", "workspace"},
            "inspect": {"action", "container"},
            "start": {"action", "container"},
            "stop": {"action", "container"},
            "remove": {"action", "container"},
            "logs": {"action", "container"},
        }
        if action not in fields or set(request) - fields[action]:
            raise Refused("UNSUPPORTED_ACTION")
        if action == "status":
            self.run(["version", "--format", "{{.Server.Version}}"])
            return {"ready": True, "mode": "shared-engine"}
        if action == "profiles":
            return {"profiles": list(self.catalog_loader().values())}
        if action == "list":
            items = []
            raw = self.run(["container", "ls", "-a", "--no-trunc", "--filter",
                            f"label=uem.owner={uid}", "--format", "{{.ID}}"])
            for raw_id in raw.splitlines():
                if len(items) >= 100:
                    raise Refused("TOO_MANY_CONTAINERS")
                try:
                    info = self._container(uid, raw_id.strip())
                except (Refused, ValueError, IndexError, KeyError):
                    # Never return unverified identifiers.
                    continue
                labels = info["Config"]["Labels"]
                items.append({"id": info["Id"], "name": info["Name"].lstrip("/"),
                              "image": info["Config"].get("Image"),
                              "state": (info.get("State") or {}).get("Status"),
                              "workspace": labels["uem.workspace"]})
            return {"containers": items}
        if action == "workspaces":
            names = self.run(["volume", "ls", "--filter", f"label=uem.owner={uid}",
                              "--format", "{{.Name}}"]).splitlines()
            prefix = f"uem-u{uid}-ws-"
            output = []
            for name in names:
                if name.startswith(prefix):
                    self._volume(uid, name)
                    output.append(name[len(prefix):])
            return {"workspaces": output}
        if action == "pull":
            profile = slug(request.get("profile"))
            p = self.catalog_loader().get(profile)
            if p is None:
                raise Refused("UNKNOWN_PROFILE")
            self.run(["image", "pull", p["image"]], timeout=1800)
            return {"pulled": p["image"]}
        if action == "create":
            profile = slug(request.get("profile"))
            name = slug(request.get("name"))
            workspace = slug(request.get("workspace"))
            p = self.catalog_loader().get(profile)
            if p is None:
                raise Refused("UNKNOWN_PROFILE")
            container_name = f"uem-u{uid}-{name}"
            volume = owner_volume(uid, workspace)
            with self.lock:
                all_names = self.run(["container", "ls", "-a", "--format", "{{.Names}}"]).splitlines()
                if container_name in all_names:
                    raise Refused("NAME_EXISTS")
                if self._volume_exists(volume):
                    self._volume(uid, volume)
                if self._volume_exists(volume) and self._workspaces_in_use(volume):
                    raise Refused("WORKSPACE_IN_USE")
                self.run(["image", "inspect", p["image"]])
                self._ensure_volume(uid, workspace)
                argv = ["container", "create", "--pull=never",
                        "--name", container_name,
                        "--label", "uem.managed=1",
                        "--label", f"uem.owner={uid}",
                        "--label", f"uem.workspace={workspace}",
                        "--network", "bridge",
                        "--cap-drop", "ALL",
                        "--security-opt", "no-new-privileges",
                        "--pids-limit", str(p["pids"]),
                        "--memory", p["memory"],
                        "--mount", f"type=volume,source={volume},target=/workspace",
                        "--workdir", "/workspace"]
                if p["gpu"]:
                    argv.extend(["--device", "nvidia.com/gpu=all"])
                argv.extend(["--entrypoint", "/bin/sh", p["image"],
                             "-c", "while :; do sleep 3600; done"])
                cid = self.run(argv).strip()
                identifier(cid)
                info = self._container(uid, cid)
            LOGGER.info("uid=%d action=create container=%s", uid, cid)
            return {"id": info["Id"], "name": container_name, "workspace": workspace}
        cid = identifier(request.get("container"))
        with self.lock:
            info = self._container(uid, cid)
            if action == "inspect":
                labels = info["Config"]["Labels"]
                return {"id": cid, "name": info["Name"].lstrip("/"),
                        "image": info["Config"].get("Image"),
                        "state": (info.get("State") or {}).get("Status"),
                        "workspace": labels["uem.workspace"]}
            if action == "logs":
                logs = self.run(["container", "logs", "--tail", "100", cid])
                return {"logs": logs[-MAX_LOGS:]}
            if action == "start":
                workspace = info["Config"]["Labels"]["uem.workspace"]
                if self._workspaces_in_use(owner_volume(uid, workspace)):
                    raise Refused("WORKSPACE_IN_USE")
                self.run(["container", "start", cid])
            elif action == "stop":
                self.run(["container", "stop", "--time", "10", cid])
            elif action == "remove":
                # No -v: deleting the container must preserve its workspace.
                self.run(["container", "rm", cid])
            else:
                raise Refused("UNSUPPORTED_ACTION")
            LOGGER.info("uid=%d action=%s container=%s", uid, action, cid)
            return {"result": "ok", "data_preserved": action == "remove"}


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        with self.server.slots:
            self.connection.settimeout(60)
            try:
                raw = self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                _, uid, _ = struct.unpack("3i", raw)
                if not member_allowed(uid):
                    raise Refused("UNAUTHORIZED")
                line = self.rfile.readline(MAX_REQUEST + 1)
                if len(line) > MAX_REQUEST or not line.endswith(b"\n"):
                    raise Refused("INVALID_REQUEST")
                request = json.loads(line)
                result = self.server.engine.execute(uid, request)
                response = {"ok": True, "result": result}
            except (Refused, ValueError, TypeError, KeyError, IndexError, json.JSONDecodeError) as exc:
                response = {"ok": False, "error": str(exc) if isinstance(exc, Refused) else "INVALID_REQUEST"}
            except Exception:
                LOGGER.exception("Internal shared-engine broker failure")
                response = {"ok": False, "error": "INTERNAL_ERROR"}
            payload = (json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8")
            if len(payload) > MAX_RESPONSE:
                payload = b'{"ok":false,"error":"RESPONSE_TOO_LARGE"}\n'
            try:
                self.wfile.write(payload)
            except OSError:
                pass


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address, engine):
        self.engine = engine
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(address, Handler)


def serve():
    if os.geteuid() != 0:
        raise SystemExit("broker must run as root")
    parent = Path(SOCKET).parent
    meta = parent.stat()
    if (not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022):
        raise SystemExit("runtime directory must be root-owned and not group writable")
    if os.path.lexists(SOCKET):
        raise SystemExit("broker socket already exists; inspect existing service, do not auto-remove")
    config_dir = parent / "docker-config"
    config_dir.mkdir(mode=0o700, exist_ok=True)
    config_meta = config_dir.stat()
    if config_meta.st_uid != 0 or config_meta.st_mode & 0o077:
        raise SystemExit("broker Docker config path is unsafe")
    gid = grp.getgrnam(MEMBER_GROUP).gr_gid
    with Server(SOCKET, Engine()) as server:
        os.chown(SOCKET, 0, gid)
        os.chmod(SOCKET, 0o660)
        LOGGER.info("shared-engine broker started")
        server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    if sys.argv[1:] != ["serve"]:
        raise SystemExit("usage: shared_engine_broker.py serve")
    serve()
