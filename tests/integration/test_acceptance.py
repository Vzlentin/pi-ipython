from __future__ import annotations

import json
import os
import select
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
EXTENSION = ROOT / "extensions" / "rlm.ts"
BRIDGE = ROOT / "extensions" / "ipython.py"
MODEL = os.environ.get("PI_RLM_TEST_MODEL")
PROVIDER_EXTENSION = os.environ.get("PI_RLM_TEST_PROVIDER_EXTENSION")
THINKING = os.environ.get("PI_RLM_TEST_THINKING", "low")
TIMEOUT = int(os.environ.get("PI_RLM_TEST_TIMEOUT", "300"))
INCLUDE_LARGE = os.environ.get("PI_RLM_TEST_INCLUDE_LARGE") == "1"


def test_env() -> dict[str, str]:
    env = dict(os.environ)
    env["PI_CODING_AGENT_DIR"] = os.environ.get(
        "PI_RLM_TEST_AGENT_DIR", env.get("PI_CODING_AGENT_DIR", str(Path.home() / ".pi" / "agent"))
    )
    return env


def base_command(mode: str) -> list[str]:
    if not MODEL:
        raise RuntimeError("Set PI_RLM_TEST_MODEL, for example openai-codex/gpt-5.6-sol")
    return [
        "pi",
        "--mode",
        mode,
        "--no-session",
        "-ne",
        "-ns",
        "-nc",
        "-nbt",
        *(["-e", PROVIDER_EXTENSION] if PROVIDER_EXTENSION else []),
        "-e",
        str(EXTENSION),
        "--model",
        MODEL,
        "--thinking",
        THINKING,
        "--tools",
        "ipython",
    ]


def decode_jsonl(payload: bytes) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for raw in payload.splitlines():
        if raw:
            events.append(json.loads(raw))
    return events


def run_print(prompt: str, timeout: int = TIMEOUT) -> list[dict[str, Any]]:
    result = subprocess.run(
        [*base_command("json"), "-p", prompt],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=test_env(),
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0 or result.stderr:
        raise AssertionError(
            f"Pi failed with {result.returncode}:\n{result.stderr.decode(errors='replace')}"
        )
    return decode_jsonl(result.stdout)


def tool_end(events: list[dict[str, Any]]) -> dict[str, Any]:
    matches = [event for event in events if event.get("type") == "tool_execution_end"]
    if len(matches) != 1:
        raise AssertionError(f"Expected one tool result, got {len(matches)}")
    return matches[0]


def host_directories() -> set[Path]:
    return set(Path("/tmp").glob("pi-rlm-host-*"))


def bridge_processes() -> set[str]:
    result = subprocess.run(
        ["ps", "-axww", "-o", "pid=,command="], stdout=subprocess.PIPE, text=True, check=True
    )
    return {line.strip() for line in result.stdout.splitlines() if str(BRIDGE) in line}


def bridge_command() -> list[str]:
    provisioned = ROOT / "extensions" / ".rlm-python" / "bin" / "python"
    if provisioned.is_file():
        return [str(provisioned), "-I", str(BRIDGE)]
    return [
        "uv",
        "run",
        "--no-project",
        "--python",
        "3.12",
        "--with",
        "ipykernel>=7,<8",
        "--with",
        "jupyter-client>=8,<9",
        "python",
        "-I",
        str(BRIDGE),
    ]


def read_bridge_event(process: subprocess.Popen[bytes], deadline: float) -> dict[str, Any]:
    assert process.stdout is not None
    while time.monotonic() < deadline:
        ready, _, _ = select.select([process.stdout], [], [], min(0.2, deadline - time.monotonic()))
        if not ready:
            continue
        raw = process.stdout.readline()
        if raw:
            return json.loads(raw)
        break
    stderr = b""
    if process.poll() is not None and process.stderr is not None:
        stderr = process.stderr.read()
    raise AssertionError(
        f"Timed out waiting for bridge event; exit={process.poll()} "
        f"stderr={stderr.decode(errors='replace')}"
    )


def execute_bridge(
    process: subprocess.Popen[bytes], request_id: str, code: str, cwd: Path
) -> list[dict[str, Any]]:
    assert process.stdin is not None
    process.stdin.write(
        json.dumps(
            {"type": "execute", "request_id": request_id, "code": code, "cwd": str(cwd)}
        ).encode()
        + b"\n"
    )
    process.stdin.flush()
    deadline = time.monotonic() + 30
    events: list[dict[str, Any]] = []
    while True:
        event = read_bridge_event(process, deadline)
        events.append(event)
        if event.get("request_id") == request_id and event.get("type") in {
            "result",
            "bridge_error",
        }:
            return events


class BridgeWorkingDirectoryAcceptanceTests(unittest.TestCase):
    def test_persistent_kernel_applies_each_cwd_to_cells_and_children(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pi-rlm-bridge-cwd-") as directory:
            root = Path(directory).resolve()
            first_cwd = root / "first"
            second_cwd = root / "second"
            first_cwd.mkdir()
            second_cwd.mkdir()
            socket_path = root / "host.sock"
            auth_token = "acceptance-token"
            child_requests: list[dict[str, Any]] = []
            server_errors: list[BaseException] = []

            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(socket_path))
            server.listen()

            def serve_child() -> None:
                try:
                    connection, _ = server.accept()
                    with connection:
                        payload = bytearray()
                        while b"\n" not in payload:
                            chunk = connection.recv(64 * 1024)
                            if not chunk:
                                raise ConnectionError("bridge closed the child request")
                            payload.extend(chunk)
                        request = json.loads(bytes(payload).split(b"\n", 1)[0])
                        child_requests.append(request)
                        result = {
                            "status": "ok",
                            "text": "child-ok",
                            "error": None,
                            "usage": {},
                            "elapsed_ms": 1,
                            "truncated": False,
                        }
                        connection.sendall(
                            json.dumps(
                                {
                                    "version": 2,
                                    "id": request["id"],
                                    "ok": True,
                                    "result": result,
                                }
                            ).encode()
                            + b"\n"
                        )
                except BaseException as error:
                    server_errors.append(error)

            server_thread = threading.Thread(target=serve_child, daemon=True)
            server_thread.start()
            env = dict(
                os.environ,
                RLM_HOST_SOCKET=str(socket_path),
                RLM_HOST_TOKEN=auth_token,
                RLM_KERNEL_CWD=str(first_cwd),
            )
            process = subprocess.Popen(
                bridge_command(),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                bufsize=0,
            )
            try:
                deadline = time.monotonic() + 60
                while read_bridge_event(process, deadline).get("type") != "ready":
                    pass
                first = execute_bridge(
                    process,
                    "cwd-one",
                    "from pathlib import Path; print(Path.cwd())",
                    first_cwd,
                )
                second = execute_bridge(
                    process,
                    "cwd-two",
                    "from pathlib import Path; print(Path.cwd()); "
                    "h=await rlm.spawn('cwd child'); "
                    "print((await rlm.gather([h]))[0]['text'])",
                    second_cwd,
                )
            finally:
                if process.stdin is not None and not process.stdin.closed:
                    if process.poll() is None:
                        process.stdin.write(b'{"type":"shutdown"}\n')
                        process.stdin.flush()
                    process.stdin.close()
                try:
                    exit_code = process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    process.kill()
                    exit_code = process.wait()
                stderr = process.stderr.read() if process.stderr is not None else b""
                if process.stdout is not None:
                    process.stdout.close()
                if process.stderr is not None:
                    process.stderr.close()
                server.close()
                server_thread.join(timeout=2)

            self.assertEqual(exit_code, 0, stderr.decode(errors="replace"))
            self.assertEqual(server_errors, [])
            self.assertFalse(server_thread.is_alive())
            self.assertEqual(len(child_requests), 1)
            self.assertEqual(child_requests[0]["auth"], auth_token)
            self.assertEqual(child_requests[0]["cwd"], str(second_cwd))

            first_output = "".join(
                event.get("text", "") for event in first if event.get("type") == "output"
            )
            second_output = "".join(
                event.get("text", "") for event in second if event.get("type") == "output"
            )
            self.assertEqual(first_output.strip(), str(first_cwd))
            self.assertEqual(second_output.splitlines(), [str(second_cwd), "child-ok"])


class ViewerConnectionAcceptanceTests(unittest.TestCase):
    def test_connection_reset_and_viewer_cleanup(self) -> None:
        subprocess.run(
            ["node", "--no-warnings", str(ROOT / "tests" / "test_cells.mjs"), "--kernel"],
            cwd=ROOT,
            check=True,
            timeout=120,
        )


class RpcPi:
    def __init__(self) -> None:
        self.process = subprocess.Popen(
            base_command("rpc"),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=test_env(),
            bufsize=0,
        )
        self.buffer = b""
        self.command_index = 0

    def send(self, value: dict[str, Any]) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(value).encode() + b"\n")
        self.process.stdin.flush()

    def read_event(self, deadline: float) -> dict[str, Any]:
        assert self.process.stdout is not None
        while time.monotonic() < deadline:
            if b"\n" in self.buffer:
                raw, self.buffer = self.buffer.split(b"\n", 1)
                if raw:
                    return json.loads(raw)
                continue
            ready, _, _ = select.select(
                [self.process.stdout], [], [], min(0.2, deadline - time.monotonic())
            )
            if not ready:
                continue
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                break
            self.buffer += chunk
        stderr = b""
        if self.process.poll() is not None and self.process.stderr is not None:
            stderr = self.process.stderr.read()
        raise AssertionError(
            f"Timed out waiting for Pi RPC event; exit={self.process.poll()} "
            f"stderr={stderr.decode(errors='replace')}"
        )

    def collect_until(
        self, predicate: Callable[[dict[str, Any], list[dict[str, Any]]], bool]
    ) -> list[dict[str, Any]]:
        deadline = time.monotonic() + TIMEOUT
        events: list[dict[str, Any]] = []
        while True:
            event = self.read_event(deadline)
            events.append(event)
            if predicate(event, events):
                return events

    def prompt(self, message: str) -> list[dict[str, Any]]:
        self.command_index += 1
        command_id = f"prompt-{self.command_index}"
        self.send({"id": command_id, "type": "prompt", "message": message})
        events = self.collect_until(lambda event, _events: event.get("type") == "agent_settled")
        responses = [
            event
            for event in events
            if event.get("type") == "response" and event.get("id") == command_id
        ]
        if len(responses) != 1 or responses[0].get("success") is not True:
            raise AssertionError(f"Prompt was not accepted: {responses}")
        return events

    def abort_after_progress(self, prompt: str, marker: str) -> list[dict[str, Any]]:
        self.command_index += 1
        prompt_id = f"prompt-{self.command_index}"
        abort_id = f"abort-{self.command_index}"
        self.send({"id": prompt_id, "type": "prompt", "message": prompt})
        events: list[dict[str, Any]] = []
        deadline = time.monotonic() + TIMEOUT
        while True:
            event = self.read_event(deadline)
            events.append(event)
            if event.get("type") == "tool_execution_update" and marker in json.dumps(event):
                break
        self.send({"id": abort_id, "type": "abort"})
        abort_ok = False
        settled = False
        while not (abort_ok and settled):
            event = self.read_event(deadline)
            events.append(event)
            if event.get("type") == "response" and event.get("id") == abort_id:
                abort_ok = event.get("success") is True
            if event.get("type") == "agent_settled":
                settled = True
        return events

    def close(self) -> None:
        if self.process.stdin is not None:
            self.process.stdin.close()
        try:
            code = self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.process.kill()
            code = self.process.wait()
        stderr = self.process.stderr.read() if self.process.stderr is not None else b""
        if self.process.stdout is not None:
            self.process.stdout.close()
        if self.process.stderr is not None:
            self.process.stderr.close()
        if code != 0 or stderr:
            raise AssertionError(
                f"Pi RPC shutdown failed with {code}: {stderr.decode(errors='replace')}"
            )


@unittest.skipUnless(MODEL, "Set PI_RLM_TEST_MODEL to run model-backed acceptance tests")
class Slice2AcceptanceTests(unittest.TestCase):
    def assert_cleanup(self, before: tuple[set[Path], set[str]]) -> None:
        time.sleep(1)
        directories, processes = before
        self.assertEqual(host_directories() - directories, set())
        self.assertEqual(bridge_processes() - processes, set())

    def test_parallel_progress_final_and_usage(self) -> None:
        prompt = """Call ipython exactly once with this exact code and do nothing else: import asyncio
print("\\n".join(f"line-{i}" for i in range(12)))
await asyncio.sleep(0.2)
hs=[await rlm.spawn("Reply with exactly ALPHA."),await rlm.spawn("Reply with exactly BETA.")]
rs=await rlm.gather(hs)
await rlm.final({"statuses":[r["status"] for r in rs],"texts":[r["text"] for r in rs]})"""
        events = run_print(prompt)
        end = tool_end(events)
        result = end["result"]
        self.assertFalse(end["isError"])
        self.assertTrue(result["terminate"])
        self.assertEqual(result["details"]["final"]["statuses"], ["ok", "ok"])
        self.assertEqual(
            [text.strip() for text in result["details"]["final"]["texts"]],
            ["ALPHA", "BETA"],
        )
        self.assertGreater(result["details"]["nestedUsage"]["totalTokens"], 0)
        progress = [
            event["partialResult"]["content"][0]["text"]
            for event in events
            if event.get("type") == "tool_execution_update"
            and "RLM child" in event["partialResult"]["content"][0]["text"]
        ]
        waiting = next(text for text in progress if "Waiting for 2 RLM children…" in text)
        self.assertTrue(waiting.startswith("Waiting for 2 RLM children…"))
        self.assertIn("line-11", waiting)
        self.assertTrue(any(text.startswith("RLM children completed: 2/2") for text in progress))
        self.assertIn("[RLM final — terminating]", result["content"][0]["text"])

    def test_failed_cell_preserves_child_usage_once(self) -> None:
        rpc = RpcPi()
        try:
            events = rpc.prompt(
                '''Call ipython exactly once with this exact code. The error is intentional; do not retry or fix it: h=await rlm.spawn("Reply with exactly ALPHA.")
child=(await rlm.gather([h]))[0]
raise ValueError("intentional failure after gather")'''
            )
            end = tool_end(events)
            result = end["result"]
            self.assertTrue(end["isError"])
            self.assertIn("intentional failure after gather", result["content"][0]["text"])
            self.assertIn("usage", result)
            self.assertGreater(result["usage"]["totalTokens"], 0)
            self.assertEqual(result["details"]["status"], "error")
            self.assertEqual(result["details"]["nestedUsage"], result["usage"])
            messages = [
                event["message"]
                for event in events
                if event.get("type") == "message_end"
                and event["message"].get("role") == "toolResult"
            ]
            self.assertEqual(len(messages), 1)
            self.assertTrue(messages[0]["isError"])
            self.assertEqual(messages[0]["usage"], result["usage"])

            recovered = tool_end(rpc.prompt(
                '''Call ipython exactly once with this exact code and do nothing else: await rlm.final(child)'''
            ))["result"]
            self.assertEqual(recovered["details"]["final"]["status"], "ok")
            self.assertEqual(recovered["details"]["final"]["usage"], result["usage"])
            self.assertFalse(recovered.get("usage"))
            self.assertFalse(recovered["details"]["kernelReset"])
        finally:
            rpc.close()

    def test_atomic_concurrent_gather(self) -> None:
        prompt = """Call ipython exactly once with this exact code and do nothing else: import asyncio
h=await rlm.spawn("Reply with exactly ALPHA.")
async def one_gather():
    try:
        value=await rlm.gather([h])
        return {"kind":"ok","text":value[0]["text"],"usage":value[0]["usage"]}
    except Exception as e:
        return {"kind":"error","type":type(e).__name__}
a,b=await asyncio.gather(one_gather(),one_gather())
await rlm.final({"attempts":[a,b]})"""
        result = tool_end(run_print(prompt))["result"]
        attempts = result["details"]["final"]["attempts"]
        self.assertEqual(sorted(item["kind"] for item in attempts), ["error", "ok"])
        successful = next(item for item in attempts if item["kind"] == "ok")
        self.assertEqual(result["details"]["nestedUsage"], successful["usage"])
        self.assertEqual(result["details"]["children"], {"spawned": 1, "gathered": 1})

    def test_failed_admission_preserves_sibling(self) -> None:
        prompt = """Call ipython exactly once with this exact code and do nothing else: good=await rlm.spawn("Reply with exactly SURVIVED.")
try:
    await rlm.spawn("oversized", context="x"*(1024*1024))
except Exception as e:
    failed={"type":type(e).__name__,"message":str(e)}
result=(await rlm.gather([good]))[0]
await rlm.final({"failed":failed,"sibling":{"status":result["status"],"text":result["text"]}})"""
        final = tool_end(run_print(prompt))["result"]["details"]["final"]
        self.assertEqual(final["failed"]["type"], "RLMHostError")
        self.assertEqual(final["sibling"]["status"], "ok")
        self.assertEqual(final["sibling"]["text"].strip(), "SURVIVED")

    def test_handle_release_cancels_child_and_cleans_up(self) -> None:
        before = host_directories(), bridge_processes()
        rpc = RpcPi()
        try:
            released = rpc.prompt(
                '''Call ipython exactly once with this exact code and do nothing else: import asyncio
h=await rlm.spawn("Write 20,000 numbered lines. Do not summarize or stop early.")
await asyncio.sleep(0.1)
await h.release()
await rlm.final({"released": True})'''
            )
            result = tool_end(released)["result"]
            self.assertEqual(result["details"]["final"], {"released": True})
            self.assertEqual(result["details"]["children"], {"spawned": 1, "gathered": 0})
            recovered = rpc.prompt(
                '''Call ipython exactly once with this exact code and do nothing else: await rlm.final({"recovered": True})'''
            )
            self.assertEqual(
                tool_end(recovered)["result"]["details"]["final"],
                {"recovered": True},
            )
        finally:
            rpc.close()
        self.assert_cleanup(before)

    def test_active_cancellation_recovers_and_cleans_up(self) -> None:
        before = host_directories(), bridge_processes()
        rpc = RpcPi()
        try:
            cancelled = rpc.abort_after_progress(
                """Call ipython exactly once with this exact code and do nothing else: h=await rlm.spawn("Write 20,000 numbered lines. Do not summarize or stop early.")
await rlm.gather([h])""",
                "Waiting for 1 RLM child",
            )
            errors = [
                event
                for event in cancelled
                if event.get("type") == "tool_execution_end" and event.get("isError")
            ]
            self.assertEqual(len(errors), 1)
            recovered = rpc.prompt(
                """Call ipython exactly once with this exact code and do nothing else: await rlm.final({"recovered": True})"""
            )
            result = tool_end(recovered)["result"]
            self.assertTrue(result["details"]["kernelReset"])
            self.assertEqual(result["details"]["final"], {"recovered": True})
        finally:
            rpc.close()
        self.assert_cleanup(before)

    def test_startup_cancellation_recovers_and_cleans_up(self) -> None:
        before = host_directories(), bridge_processes()
        rpc = RpcPi()
        try:
            rpc.abort_after_progress(
                """Call ipython exactly once with this exact code and do nothing else: import asyncio
await asyncio.sleep(60)""",
                "Starting IPython kernel",
            )
            recovered = rpc.prompt(
                """Call ipython exactly once with this exact code and do nothing else: await rlm.final({"recovered": True})"""
            )
            self.assertEqual(tool_end(recovered)["result"]["details"]["final"], {"recovered": True})
        finally:
            rpc.close()
        self.assert_cleanup(before)

    def test_cross_cell_handle_survives_background_gather(self) -> None:
        rpc = RpcPi()
        try:
            rpc.prompt(
                '''Call ipython exactly once with this exact code and do nothing else: import asyncio
h=await rlm.spawn("Reply with exactly CROSSCELL.")
background=asyncio.create_task(rlm.gather([h]))
"spawned"'''
            )
            events = rpc.prompt(
                """Call ipython exactly once with this exact code and do nothing else: result=(await rlm.gather([h]))[0]
await rlm.final({"status":result["status"],"text":result["text"]})"""
            )
            final = tool_end(events)["result"]["details"]["final"]
            self.assertEqual(final["status"], "ok")
            self.assertEqual(final["text"].strip(), "CROSSCELL")
        finally:
            rpc.close()

    @unittest.skipUnless(
        INCLUDE_LARGE, "Set PI_RLM_TEST_INCLUDE_LARGE=1 for the costly large-context case"
    )
    def test_large_context_stays_out_of_root_prompt(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pi-rlm-test-") as directory:
            path = Path(directory) / "context.txt"
            with path.open("w") as output:
                for index in range(12_000):
                    label = "ALPHA" if index % 3 else "BETA"
                    output.write(f"{index:05d}|{label}|payload-{index * index:012d}\n")
            code = f"""from pathlib import Path
raw=Path({str(path)!r}).read_text()
lines=raw.splitlines()
chunks=["\\n".join(lines[:6000]),"\\n".join(lines[6000:])]
hs=[await rlm.spawn("Count the records in this context. Reply with only the integer.",context=chunk) for chunk in chunks]
rs=await rlm.gather(hs)
await rlm.final({{"bytes_loaded":len(raw.encode()),"records":len(lines),"statuses":[r["status"] for r in rs],"answers":[r["text"] for r in rs]}})"""
            events = run_print(
                f"Call ipython exactly once with this exact code and do nothing else: {code}"
            )
            final = tool_end(events)["result"]["details"]["final"]
            self.assertEqual(final["bytes_loaded"], 392_000)
            self.assertEqual(final["records"], 12_000)
            self.assertEqual(final["statuses"], ["ok", "ok"])
            self.assertEqual([answer.strip() for answer in final["answers"]], ["6000", "6000"])


if __name__ == "__main__":
    unittest.main()
