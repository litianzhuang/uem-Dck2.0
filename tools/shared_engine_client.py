#!/usr/bin/env python3
"""Unprivileged CLI for the restricted local shared-engine broker.

This protocol never sends a user ID, Docker Socket URL, shell command,
host path or arbitrary Docker CLI flags. Server always authenticates SO_PEERCRED.
"""
import argparse
import json
import socket
import sys

SOCKET = "/run/uem-shared-engine/broker.sock"
FIELDS = {
    "status": [],
    "profiles": [],
    "list": [],
    "workspaces": [],
    "pull": ["profile"],
    "create": ["profile", "name", "workspace"],
    "inspect": ["container"],
    "start": ["container"],
    "stop": ["container"],
    "remove": ["container"],
    "logs": ["container"],
}


class RequestError(Exception):
    pass


def request(action, values, path=SOCKET):
    if action not in FIELDS or len(values) != len(FIELDS[action]):
        raise RequestError("INVALID_ARGUMENTS")
    payload = {"action": action, **dict(zip(FIELDS[action], values))}
    data = (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8")
    if len(data) > 8192:
        raise RequestError("INVALID_ARGUMENTS")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(1900 if action == "pull" else 65)
        connection.connect(path)
        connection.sendall(data)
        chunks = []
        size = 0
        while True:
            chunk = connection.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > 1024 * 1024:
                raise RequestError("RESPONSE_TOO_LARGE")
            if b"\n" in chunk:
                break
    try:
        response = json.loads(b"".join(chunks))
    except (ValueError, UnicodeError) as exc:
        raise RequestError("INVALID_RESPONSE") from exc
    if not isinstance(response, dict) or response.get("ok") is not True:
        raise RequestError(str(response.get("error", "BROKER_REFUSED")) if isinstance(response, dict) else "INVALID_RESPONSE")
    return response["result"]


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=FIELDS)
    parser.add_argument("values", nargs="*")
    args = parser.parse_args(argv)
    try:
        result = request(args.action, args.values)
        print(json.dumps({"action": args.action, **result}, ensure_ascii=False))
        return 0
    except (OSError, RequestError) as exc:
        print(json.dumps({"error": str(exc), "status": "REFUSED"}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
