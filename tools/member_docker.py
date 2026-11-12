#!/usr/bin/env python3
"""Minimal compatibility shim for original 106-Docker Cockpit member UI.

This runs as the authenticated Linux member. It sends only fixed actions to the
root-controlled shared Engine broker, which independently authenticates the
peer UID. Unsupported legacy functionality must fail closed.

PROTOTYPE: no real Cockpit/VM A/B acceptance; do not install on production.
"""
from __future__ import annotations

import argparse
import json
import sys

from shared_engine_client import RequestError, request

PASSTHROUGH = {
    "profiles": "profiles",
    "list": "list",
    "workspaces": "workspaces",
    "start": "start",
    "stop": "stop",
    "remove": "remove",
    "logs": "logs",
}
BLOCKED_CREATE = {
    "NAME_EXISTS": "NAME_TAKEN",
    "WORKSPACE_IN_USE": "WORKSPACE_BUSY",
    "UNKNOWN_PROFILE": "INVALID_PROFILE",
    "INVALID_NAME": "INVALID_PROFILE",
    "CATALOG_INVALID": "INVALID_PROFILE",
}


def handle(action, values, caller=request):
    """Convert broker replies to existing UI JSON. Never forward a UID."""
    if action == "status":
        if values:
            raise RequestError("INVALID_ARGUMENTS")
        broker = caller("status", [])
        if broker.get("ready") is not True or broker.get("mode") != "shared-engine":
            raise RequestError("NOT_READY")
        return {
            "action": action,
            "status": "PASS",
            "mode": "shared-engine",
            "preflight": {
                "status": "PASS",
                "checks": [
                    {"id": "shared-engine", "result": "PASS",
                     "detail": "本地受控共享 Docker 服务可达；真实隔离验收仍待完成"}
                ],
            },
        }
    if action == "snapshots":
        # UI can show the section as unavailable; do not forge a PASS.
        raise RequestError("NOT_IMPLEMENTED_SNAPSHOTS")
    if action == "create":
        # Legacy signature: create(name, profile, workspace[, custom image]).
        # Custom references are deliberately unsupported until disk/registry
        # policy and per-member quotas are reviewed. Profiles are root-owned.
        if len(values) != 3:
            raise RequestError("UNSUPPORTED_CUSTOM_IMAGE")
        name, profile, workspace = values
        try:
            result = caller("create", [profile, name, workspace])
        except RequestError as exc:
            code = BLOCKED_CREATE.get(str(exc), "CREATE_REFUSED")
            return {"action": action, "status": "BLOCKED", "code": code}
        return {"action": action, "status": "PASS", "environment": result}
    if action == "pull":
        if len(values) != 1:
            raise RequestError("INVALID_ARGUMENTS")
        result = caller("pull", values)
        return {"action": action, "status": "PASS", **result}
    if action in PASSTHROUGH:
        expected = 1 if action in {"start", "stop", "remove", "logs"} else 0
        if len(values) != expected:
            raise RequestError("INVALID_ARGUMENTS")
        result = caller(PASSTHROUGH[action], values)
        if action == "list":
            for item in result.get("containers", []):
                # Original UI shows one human status and one machine state.
                item.setdefault("status", item.get("state", "unknown"))
        return {"action": action, "status": "PASS", **result}
    raise RequestError("NOT_IMPLEMENTED")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("action")
    parser.add_argument("values", nargs="*")
    args = parser.parse_args(argv)
    try:
        result = handle(args.action, args.values)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("status") == "PASS" or result.get("action") == "create" else 2
    except (RequestError, OSError, ValueError) as exc:
        # No Docker stderr, socket pathname, peer UID or server trace in the UI.
        error = str(exc)
        code = error if error.startswith("NOT_IMPLEMENTED") else "BACKEND_UNAVAILABLE"
        print(json.dumps({"action": args.action, "status": "BLOCKED", "code": code}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
