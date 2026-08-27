#!/usr/bin/env python3
"""Jupyter bridge and Python side of the extension-owned RLM host protocol."""

from __future__ import annotations

import asyncio
import contextvars
from dataclasses import dataclass, field
import json
import os
import queue
import secrets
import signal
import subprocess
import sys
import traceback
from typing import Any, Iterable

# This file is intentionally named ipykernel.py. Keep its directory off sys.path so
# it cannot shadow the installed ipykernel package used by jupyter_client.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path = [
    path
    for path in sys.path
    if os.path.abspath(path or os.getcwd()) != _SCRIPT_DIR
]

from jupyter_client import KernelManager  # noqa: E402

_OUTPUT_MESSAGE_CHARS = 16_384
_HOST_PROTOCOL_VERSION = 1
_HOST_RESPONSE_LIMIT = 5 * 1024 * 1024
_HOST_TIMEOUT_SECONDS = 310


class RLMHostError(RuntimeError):
    """A single RLM host operation failed without invalidating the kernel."""


@dataclass(slots=True, eq=False)
class RLMHandle:
    """Opaque handle for a focused child session."""

    _client: "RLMClient" = field(repr=False)
    _id: str = field(repr=False)
    _result: dict[str, Any] | None = field(default=None, repr=False)

    def __repr__(self) -> str:
        state = "ready" if self._result is not None else "pending"
        return f"<rlm.Handle {state}>"


class RLMClient:
    """Narrow async Python API backed by the authenticated host socket."""

    def __init__(self, socket_path: str, auth_token: str) -> None:
        if not socket_path or not auth_token:
            raise RuntimeError("RLM host socket configuration is missing")
        self._socket_path = socket_path
        self._auth_token = auth_token
        self._pending_execution_id: str | None = None
        self._execution_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
            "pi_rlm_execution_id", default=None
        )
        self._ipython_hook_installed = False

    def _set_execution(self, execution_id: str) -> None:
        if not isinstance(execution_id, str) or not execution_id:
            raise ValueError("execution id must be a non-empty string")
        self._pending_execution_id = execution_id

    def _activate_execution(self, *_args: Any, **_kwargs: Any) -> None:
        # IPython invokes pre_run_cell in the user cell's task context. ContextVar
        # values are then inherited by tasks created in that cell, so stale
        # background tasks cannot accidentally adopt a later cell's identity.
        if self._pending_execution_id is not None:
            self._execution_id.set(self._pending_execution_id)

    def _install_ipython_hook(self, shell: Any) -> None:
        if self._ipython_hook_installed:
            return
        shell.events.register("pre_run_cell", self._activate_execution)
        self._ipython_hook_installed = True

    async def spawn(self, task: str, *, context: str | None = None) -> RLMHandle:
        """Admit one fresh, tool-free child and return immediately with its handle."""
        if not isinstance(task, str):
            raise TypeError("rlm.spawn task must be a string")
        if context is not None and not isinstance(context, str):
            raise TypeError("rlm.spawn context must be a string or None")
        result = await self._request(
            "spawn", task=task, context=context, cwd=os.getcwd()
        )
        handle = result.get("handle") if isinstance(result, dict) else None
        if not isinstance(handle, str):
            raise RLMHostError("RLM host returned an invalid child handle")
        return RLMHandle(self, handle)

    async def gather(self, handles: Iterable[RLMHandle]) -> list[dict[str, Any]]:
        """Wait for children and return ordered status/text/error/usage values."""
        try:
            items = list(handles)
        except TypeError as error:
            raise TypeError("rlm.gather requires an iterable of rlm handles") from error
        for handle in items:
            if not isinstance(handle, RLMHandle) or handle._client is not self:
                raise TypeError("rlm.gather received a handle from another RLM client")

        unresolved = [handle for handle in items if handle._result is None]
        if unresolved:
            result = await self._request(
                "gather", handles=[handle._id for handle in unresolved]
            )
            values = result.get("results") if isinstance(result, dict) else None
            if not isinstance(values, list) or len(values) != len(unresolved):
                raise RLMHostError("RLM host returned an invalid gather result")
            validated: list[dict[str, Any]] = []
            for value in values:
                if not isinstance(value, dict):
                    raise RLMHostError("RLM host returned a malformed child value")
                validated.append(value)
            for handle, value in zip(unresolved, validated, strict=True):
                handle._result = value

        return [dict(handle._result or {}) for handle in items]

    async def final(self, value: Any) -> None:
        """Freeze the first JSON-serializable final value accepted for this cell."""
        result = await self._request("final", value=value)
        if not isinstance(result, dict) or "value" not in result:
            raise RLMHostError("RLM host returned an invalid final acknowledgement")
        return None

    async def _request(self, operation: str, **payload: Any) -> Any:
        execution_id = self._execution_id.get()
        if execution_id is None:
            raise RLMHostError("RLM API is not associated with an active IPython cell")
        request_id = secrets.token_hex(16)
        request = {
            "version": _HOST_PROTOCOL_VERSION,
            "auth": self._auth_token,
            "id": request_id,
            "execution_id": execution_id,
            "op": operation,
            **payload,
        }
        try:
            encoded = json.dumps(
                request, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            ).encode("utf-8") + b"\n"
        except (TypeError, ValueError) as error:
            raise TypeError(f"RLM request is not JSON serializable: {error}") from error

        writer: asyncio.StreamWriter | None = None
        try:
            async with asyncio.timeout(_HOST_TIMEOUT_SECONDS):
                reader, writer = await asyncio.open_unix_connection(
                    self._socket_path, limit=_HOST_RESPONSE_LIMIT
                )
                writer.write(encoded)
                await writer.drain()
                line = await reader.readline()
                if not line or not line.endswith(b"\n"):
                    raise RLMHostError("RLM host closed the socket without a response")
                if len(line) > _HOST_RESPONSE_LIMIT:
                    raise RLMHostError("RLM host response exceeded the size limit")
        except RLMHostError:
            raise
        except TimeoutError as error:
            raise RLMHostError("RLM host operation timed out") from error
        except ValueError as error:
            raise RLMHostError(f"RLM host response exceeded the size limit: {error}") from error
        except (ConnectionError, OSError) as error:
            raise RLMHostError(f"RLM host connection failed: {error}") from error
        finally:
            if writer is not None:
                writer.close()
                try:
                    async with asyncio.timeout(1):
                        await writer.wait_closed()
                except Exception:
                    pass

        try:
            response = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RLMHostError("RLM host returned invalid JSON") from error
        if not isinstance(response, dict):
            raise RLMHostError("RLM host response must be an object")
        if response.get("version") != _HOST_PROTOCOL_VERSION:
            raise RLMHostError("RLM host response has an unsupported protocol version")
        if response.get("id") != request_id:
            raise RLMHostError("RLM host response id did not match the request")
        if response.get("ok") is not True:
            message = response.get("error")
            raise RLMHostError(message if isinstance(message, str) else "RLM host failed")
        return response.get("result")


def send(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def terminate_bridge(_signum: int, _frame: Any) -> None:
    """Let process termination unwind through main() so the kernel is reaped."""
    raise SystemExit(0)


def parent_id(message: dict[str, Any]) -> str | None:
    value = message.get("parent_header", {}).get("msg_id")
    return value if isinstance(value, str) else None


def text_plain(content: dict[str, Any]) -> str | None:
    value = content.get("data", {}).get("text/plain")
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(str(part) for part in value)
    return None


def wait_for_execution(
    client: Any,
    manager: KernelManager,
    msg_id: str,
    *,
    capture_output: Any | None = None,
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
            message = client.get_shell_msg(timeout=0.05)
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
        code,
        silent=True,
        store_history=False,
        allow_stdin=False,
        stop_on_error=True,
    )
    reply = wait_for_execution(client, manager, msg_id)
    content = reply.get("content", {})
    if content.get("status") != "ok":
        name = str(content.get("ename", "BootstrapError"))
        value = str(content.get("evalue", ""))
        raise RuntimeError(f"{name}: {value}".rstrip())


def bootstrap_code(execution_id: str | None = None) -> str:
    execution_line = (
        f"_pi_rlm_client._set_execution({execution_id!r})"
        if execution_id is not None
        else "pass"
    )
    return f"""
import importlib.util as _pi_importlib_util
import os as _pi_os
import sys as _pi_sys
if "_pi_rlm_client" not in globals():
    _pi_spec = _pi_importlib_util.spec_from_file_location("_pi_rlm_bridge", {os.path.abspath(__file__)!r})
    if _pi_spec is None or _pi_spec.loader is None:
        raise RuntimeError("Could not load the RLM Python bridge")
    _pi_module = _pi_importlib_util.module_from_spec(_pi_spec)
    _pi_sys.modules["_pi_rlm_bridge"] = _pi_module
    _pi_spec.loader.exec_module(_pi_module)
    _pi_rlm_client = _pi_module.RLMClient(
        _pi_os.environ["RLM_HOST_SOCKET"], _pi_os.environ["RLM_HOST_TOKEN"]
    )
_pi_rlm_client._install_ipython_hook(get_ipython())
rlm = _pi_rlm_client
{execution_line}
"""


def execute(
    client: Any, manager: KernelManager, request_id: str, code: str
) -> None:
    # Set the host-owned cell id out of band so native cell magics can still be the
    # first line of the user's cell.
    execute_hidden(client, manager, bootstrap_code(request_id))
    msg_id = client.execute(
        code,
        silent=False,
        store_history=True,
        allow_stdin=False,
        stop_on_error=True,
    )
    pending_clear = False

    def clear() -> None:
        nonlocal pending_clear
        pending_clear = False
        send({"type": "clear", "request_id": request_id})

    def output(kind: str, text: str) -> None:
        if not text:
            return
        if pending_clear:
            clear()
        for start in range(0, len(text), _OUTPUT_MESSAGE_CHARS):
            end = min(start + _OUTPUT_MESSAGE_CHARS, len(text))
            send(
                {
                    "type": "output",
                    "request_id": request_id,
                    "kind": kind,
                    "text": text[start:end],
                    "continuation": start > 0,
                    "final": end == len(text),
                }
            )

    def capture(msg_type: str, content: dict[str, Any]) -> None:
        nonlocal pending_clear
        if msg_type == "stream":
            output(str(content.get("name", "stdout")), str(content.get("text", "")))
        elif msg_type in ("execute_result", "display_data", "update_display_data"):
            plain = text_plain(content)
            if plain is not None:
                output("result" if msg_type == "execute_result" else "display", plain)
        elif msg_type == "error":
            trace = content.get("traceback")
            if isinstance(trace, list):
                output("error", "\n".join(str(line) for line in trace))
            else:
                name = str(content.get("ename", "Error"))
                value = str(content.get("evalue", ""))
                output("error", f"{name}: {value}".rstrip())
        elif msg_type == "clear_output":
            if bool(content.get("wait")):
                pending_clear = True
            else:
                clear()

    shell_reply = wait_for_execution(
        client, manager, msg_id, capture_output=capture
    )
    content = shell_reply.get("content", {})
    status = str(content.get("status", "error"))
    error: dict[str, str] | None = None
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
    cwd = os.environ.get("RLM_KERNEL_CWD") or os.getcwd()
    manager = KernelManager(kernel_name="python3")
    # Never trust a user-level python3 kernelspec to select the interpreter. The
    # extension-owned bridge and kernel must run from the same uv environment.
    manager.kernel_spec.argv = [
        sys.executable,
        "-m",
        "ipykernel_launcher",
        "-f",
        "{connection_file}",
    ]
    client: Any | None = None

    try:
        if not os.environ.get("RLM_HOST_SOCKET") or not os.environ.get("RLM_HOST_TOKEN"):
            raise RuntimeError("RLM host socket configuration is missing")
        kernel_env = dict(os.environ)
        kernel_env["NO_COLOR"] = "1"
        manager.start_kernel(
            cwd=cwd,
            env=kernel_env,
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
        execute_hidden(client, manager, bootstrap_code())
        send(
            {
                "type": "ready",
                "protocol": 2,
                "host_protocol": _HOST_PROTOCOL_VERSION,
                "kernel_pgid": kernel_pgid,
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
                    if not isinstance(request_id, str) or not isinstance(code, str):
                        raise ValueError("execute requires string request_id and code")
                    execute(client, manager, request_id, code)
                elif msg_type == "shutdown":
                    break
                else:
                    raise ValueError(f"unknown request type: {msg_type!r}")
            except Exception as error:
                request_id = (
                    message.get("request_id") if isinstance(message, dict) else None
                )
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
        return 1
    finally:
        if client is not None:
            try:
                client.stop_channels()
            except Exception:
                pass
        try:
            if manager.has_kernel:
                manager.shutdown_kernel(now=True)
        except Exception:
            pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
