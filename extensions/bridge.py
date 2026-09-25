#!/usr/bin/env python3
"""Stdio Jupyter bridge for Pi's ipython tool.

Protocol (JSON lines). The first stdin line is {"type": "startup", "code": [...]};
each snippet runs hidden after the kernel is ready, then "ready" is sent.
Later lines are {"type": "execute", "request_id", "code", "cwd"},
{"type": "evaluate", "request_id", "expression"}, or {"type": "shutdown"}.
Output streams as "output"/"clear" messages; requests end with "result".
"""

from __future__ import annotations

import ast
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import traceback
from collections.abc import Callable
from pathlib import Path
from typing import Any

from jupyter_client import KernelManager

BRIDGE_PROTOCOL_VERSION = 2
_OUTPUT_MESSAGE_CHARS = 16_384
_SEND_LOCK = threading.Lock()


def send(message: dict[str, Any]) -> None:
    encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
    with _SEND_LOCK:
        sys.stdout.write(encoded)
        sys.stdout.flush()


def terminate_bridge(_signum: int, _frame: Any) -> None:
    """Let process termination unwind through main() so the kernel is reaped."""
    raise SystemExit(0)


def parent_id(message: dict[str, Any]) -> str | None:
    value = message.get("parent_header", {}).get("msg_id")
    return value if isinstance(value, str) else None


class IPythonOutputStream:
    """Normalize incremental Jupyter output messages and clear semantics."""

    def __init__(self, callback: Callable[[dict[str, Any]], None]) -> None:
        self.callback = callback
        self._pending_clear = False

    def feed(self, msg_type: str, content: dict[str, Any]) -> None:
        if msg_type == "clear_output":
            if bool(content.get("wait")):
                self._pending_clear = True
            else:
                self._clear()
            return

        event: dict[str, Any] | None = None
        if msg_type == "stream":
            event = {
                "type": "text",
                "kind": str(content.get("name", "stdout")),
                "text": str(content.get("text", "")),
            }
        elif msg_type in ("execute_result", "display_data", "update_display_data"):
            value = content.get("data", {}).get("text/plain")
            if isinstance(value, list):
                value = "".join(str(part) for part in value)
            if isinstance(value, str):
                event = {
                    "type": "text",
                    "kind": "result" if msg_type == "execute_result" else "display",
                    "text": value,
                }
        elif msg_type == "error":
            trace = content.get("traceback")
            if isinstance(trace, list):
                text = "\n".join(str(line) for line in trace)
            else:
                name = str(content.get("ename", "Error"))
                value = str(content.get("evalue", ""))
                text = f"{name}: {value}".rstrip()
            event = {"type": "text", "kind": "error", "text": text}

        if event is not None:
            if self._pending_clear:
                self._clear()
            if event["text"]:
                self.callback(event)

    def _clear(self) -> None:
        self._pending_clear = False
        self.callback({"type": "clear"})


def wait_for_execution(
    client: Any,
    manager: KernelManager,
    msg_id: str,
    *,
    capture_output: Callable[[str, dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    shell_reply: dict[str, Any] | None = None
    idle = False
    while shell_reply is None or not idle:
        received = False
        try:
            message = client.get_iopub_msg(timeout=0.05)
            received = True
            if parent_id(message) == msg_id:
                msg_type = message.get("header", {}).get("msg_type")
                content = message.get("content", {})
                if msg_type == "status" and content.get("execution_state") == "idle":
                    idle = True
                elif capture_output is not None:
                    capture_output(msg_type, content)
        except queue.Empty:
            pass

        try:
            message = client.get_shell_msg(timeout=0)
            received = True
            if (
                parent_id(message) == msg_id
                and message.get("header", {}).get("msg_type") == "execute_reply"
            ):
                shell_reply = message
        except queue.Empty:
            pass

        if not received and not manager.is_alive():
            raise RuntimeError("IPython kernel exited during execution")

    return shell_reply or {}


def execute_hidden(client: Any, manager: KernelManager, code: str) -> None:
    msg_id = client.execute(
        code, silent=True, store_history=False, allow_stdin=False, stop_on_error=True
    )
    content = wait_for_execution(client, manager, msg_id).get("content", {})
    if content.get("status") != "ok":
        name = str(content.get("ename", "StartupError"))
        value = str(content.get("evalue", ""))
        raise RuntimeError(f"{name}: {value}".rstrip())


def evaluate(client: Any, manager: KernelManager, request_id: str, expression: str) -> None:
    msg_id = client.execute(
        "", silent=True, store_history=False, allow_stdin=False, stop_on_error=True,
        user_expressions={"value": f"__import__('json').dumps({expression})"},
    )
    content = wait_for_execution(client, manager, msg_id).get("content", {})
    result = content.get("user_expressions", {}).get("value", {})
    if content.get("status") == "ok" and result.get("status") == "ok":
        value = json.loads(ast.literal_eval(result["data"]["text/plain"]))
        send({"type": "result", "request_id": request_id, "status": "ok", "value": value})
        return
    error = result if result.get("status") == "error" else content
    send({
        "type": "result",
        "request_id": request_id,
        "status": "error",
        "error": {
            "ename": str(error.get("ename", "EvaluationError")),
            "evalue": str(error.get("evalue", "")),
        },
    })


def execute(client: Any, manager: KernelManager, request_id: str, code: str, cwd: str) -> None:
    # Out of band so a native cell magic remains on line 1.
    execute_hidden(client, manager, f"__import__('os').chdir({cwd!r})")
    msg_id = client.execute(
        code, silent=False, store_history=True, allow_stdin=False, stop_on_error=True
    )

    def emit_output(event: dict[str, Any]) -> None:
        if event["type"] == "clear":
            send({"type": "clear", "request_id": request_id})
            return
        text = event["text"]
        for start in range(0, len(text), _OUTPUT_MESSAGE_CHARS):
            end = min(start + _OUTPUT_MESSAGE_CHARS, len(text))
            send(
                {
                    "type": "output",
                    "request_id": request_id,
                    "kind": event["kind"],
                    "text": text[start:end],
                    "continuation": start > 0,
                    "final": end == len(text),
                }
            )

    output_stream = IPythonOutputStream(emit_output)
    reply = wait_for_execution(client, manager, msg_id, capture_output=output_stream.feed)
    content = reply.get("content", {})
    status = str(content.get("status", "error"))
    error = None
    if status != "ok":
        error = {
            "ename": str(content.get("ename", "ExecutionError")),
            "evalue": str(content.get("evalue", "")),
        }
    send(
        {
            "type": "result",
            "request_id": request_id,
            "status": status,
            "execution_count": content.get("execution_count"),
            "error": error,
        }
    )


def main() -> int:
    signal.signal(signal.SIGTERM, terminate_bridge)
    cwd = os.environ.get("IPYTHON_KERNEL_CWD") or os.getcwd()
    manager = KernelManager(kernel_name="python3")
    # Keep bridge and kernel on the extension-owned Python runtime.
    manager.kernel_spec.argv = [
        sys.executable,
        "-m",
        "ipykernel_launcher",
        "-f",
        "{connection_file}",
    ]
    client: Any | None = None
    exit_code = 0
    cleanup_errors: list[BaseException] = []

    try:
        manager.start_kernel(
            cwd=cwd,
            env=dict(os.environ, NO_COLOR="1"),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        kernel_pgid = getattr(manager.provisioner, "pgid", None)
        if not isinstance(kernel_pgid, int) or kernel_pgid <= 1:
            raise RuntimeError("Jupyter did not report a valid kernel process group")
        send({"type": "kernel_started", "kernel_pgid": kernel_pgid})
        client = manager.client()
        client.start_channels()
        client.wait_for_ready(timeout=30)
        startup = json.loads(sys.stdin.readline() or "null")
        if not isinstance(startup, dict) or startup.get("type") != "startup":
            raise ValueError("the first request must be startup")
        for code in startup.get("code", []):
            if not isinstance(code, str):
                raise ValueError("startup code must be strings")
            execute_hidden(client, manager, code)
        send(
            {
                "type": "ready",
                "protocol": BRIDGE_PROTOCOL_VERSION,
                "kernel_pgid": kernel_pgid,
                "connection_file": str(Path(manager.connection_file).resolve()),
            }
        )

        for line in sys.stdin:
            message: Any = None
            try:
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise ValueError("request must be a JSON object")
                msg_type = message.get("type")
                if msg_type == "execute":
                    request_id = message.get("request_id")
                    code = message.get("code")
                    request_cwd = message.get("cwd")
                    if not all(isinstance(value, str) for value in (request_id, code, request_cwd)):
                        raise ValueError("execute requires string request_id, code, and cwd")
                    if not os.path.isabs(request_cwd) or not os.path.isdir(request_cwd):
                        raise ValueError("execute cwd must be an accessible absolute directory")
                    execute(client, manager, request_id, code, request_cwd)
                elif msg_type == "evaluate":
                    request_id = message.get("request_id")
                    expression = message.get("expression")
                    if not isinstance(request_id, str) or not isinstance(expression, str):
                        raise ValueError("evaluate requires string request_id and expression")
                    evaluate(client, manager, request_id, expression)
                elif msg_type == "shutdown":
                    break
                else:
                    raise ValueError(f"unknown request type: {msg_type!r}")
            except Exception as error:
                request_id = message.get("request_id") if isinstance(message, dict) else None
                send(
                    {
                        "type": "bridge_error",
                        "request_id": request_id,
                        "error": str(error),
                        "traceback": traceback.format_exc(),
                    }
                )
    except Exception as error:
        send({"type": "fatal", "error": str(error), "traceback": traceback.format_exc()})
        exit_code = 1
    finally:
        if client is not None:
            try:
                client.stop_channels()
            except BaseException as error:
                cleanup_errors.append(error)
        try:
            if manager.has_kernel:
                manager.shutdown_kernel(now=True)
        except BaseException as error:
            cleanup_errors.append(error)

    if cleanup_errors:
        details = "\n".join("".join(traceback.format_exception(error)) for error in cleanup_errors)
        send(
            {
                "type": "fatal",
                "error": f"bridge cleanup failed ({len(cleanup_errors)} error(s))",
                "traceback": details,
            }
        )
        return 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
