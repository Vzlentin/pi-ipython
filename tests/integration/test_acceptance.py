from __future__ import annotations

import json
import os
from pathlib import Path
import select
import subprocess
import tempfile
import time
import unittest
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[2]
EXTENSION = ROOT / "extensions" / "rlm.ts"
BRIDGE = ROOT / "extensions" / "ipkl.py"
MODEL = os.environ.get("PI_RLM_TEST_MODEL")
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


def bridge_processes() -> list[str]:
    result = subprocess.run(
        ["ps", "-eo", "cmd="], stdout=subprocess.PIPE, text=True, check=True
    )
    return [line for line in result.stdout.splitlines() if str(BRIDGE) in line]


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
    def assert_cleanup(self, before: set[Path]) -> None:
        time.sleep(1)
        self.assertEqual(host_directories() - before, set())
        self.assertEqual(bridge_processes(), [])

    def test_parallel_progress_final_and_usage(self) -> None:
        prompt = '''Call ipython exactly once with this exact code and do nothing else: hs=[await rlm.spawn("Reply with exactly ALPHA."),await rlm.spawn("Reply with exactly BETA.")]
rs=await rlm.gather(hs)
await rlm.final({"statuses":[r["status"] for r in rs],"texts":[r["text"] for r in rs]})'''
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
        self.assertIn("Waiting for 2 RLM children…", progress)
        self.assertIn("RLM children completed: 2/2", progress)
        self.assertTrue(result["content"][0]["text"].startswith("[RLM final — terminating]"))

    def test_atomic_concurrent_gather(self) -> None:
        prompt = '''Call ipython exactly once with this exact code and do nothing else: import asyncio
h=await rlm.spawn("Reply with exactly ALPHA.")
async def one_gather():
    try:
        value=await rlm.gather([h])
        return {"kind":"ok","text":value[0]["text"]}
    except Exception as e:
        return {"kind":"error","type":type(e).__name__}
a,b=await asyncio.gather(one_gather(),one_gather())
await rlm.final({"attempts":[a,b]})'''
        result = tool_end(run_print(prompt))["result"]
        attempts = result["details"]["final"]["attempts"]
        self.assertEqual(sorted(item["kind"] for item in attempts), ["error", "ok"])
        self.assertEqual(result["details"]["children"], {"spawned": 1, "gathered": 1})

    def test_failed_admission_preserves_sibling(self) -> None:
        prompt = '''Call ipython exactly once with this exact code and do nothing else: good=await rlm.spawn("Reply with exactly SURVIVED.")
try:
    await rlm.spawn("oversized", context="x"*(1024*1024))
except Exception as e:
    failed={"type":type(e).__name__,"message":str(e)}
result=(await rlm.gather([good]))[0]
await rlm.final({"failed":failed,"sibling":{"status":result["status"],"text":result["text"]}})'''
        final = tool_end(run_print(prompt))["result"]["details"]["final"]
        self.assertEqual(final["failed"]["type"], "RLMHostError")
        self.assertEqual(final["sibling"]["status"], "ok")
        self.assertEqual(final["sibling"]["text"].strip(), "SURVIVED")

    def test_active_cancellation_recovers_and_cleans_up(self) -> None:
        before = host_directories()
        rpc = RpcPi()
        try:
            cancelled = rpc.abort_after_progress(
                '''Call ipython exactly once with this exact code and do nothing else: h=await rlm.spawn("Write 20,000 numbered lines. Do not summarize or stop early.")
await rlm.gather([h])''',
                "Waiting for 1 RLM child",
            )
            errors = [
                event
                for event in cancelled
                if event.get("type") == "tool_execution_end" and event.get("isError")
            ]
            self.assertEqual(len(errors), 1)
            recovered = rpc.prompt(
                '''Call ipython exactly once with this exact code and do nothing else: await rlm.final({"recovered": True})'''
            )
            result = tool_end(recovered)["result"]
            self.assertTrue(result["details"]["kernelReset"])
            self.assertEqual(result["details"]["final"], {"recovered": True})
        finally:
            rpc.close()
        self.assert_cleanup(before)

    def test_startup_cancellation_recovers_and_cleans_up(self) -> None:
        before = host_directories()
        rpc = RpcPi()
        try:
            rpc.abort_after_progress(
                '''Call ipython exactly once with this exact code and do nothing else: import asyncio
await asyncio.sleep(60)''',
                "Starting IPython kernel",
            )
            recovered = rpc.prompt(
                '''Call ipython exactly once with this exact code and do nothing else: await rlm.final({"recovered": True})'''
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
                '''Call ipython exactly once with this exact code and do nothing else: result=(await rlm.gather([h]))[0]
await rlm.final({"status":result["status"],"text":result["text"]})'''
            )
            final = tool_end(events)["result"]["details"]["final"]
            self.assertEqual(final["status"], "ok")
            self.assertEqual(final["text"].strip(), "CROSSCELL")
        finally:
            rpc.close()

    @unittest.skipUnless(INCLUDE_LARGE, "Set PI_RLM_TEST_INCLUDE_LARGE=1 for the costly large-context case")
    def test_large_context_stays_out_of_root_prompt(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pi-rlm-test-") as directory:
            path = Path(directory) / "context.txt"
            with path.open("w") as output:
                for index in range(12_000):
                    label = "ALPHA" if index % 3 else "BETA"
                    output.write(f"{index:05d}|{label}|payload-{index * index:012d}\n")
            code = f'''from pathlib import Path
raw=Path({str(path)!r}).read_text()
lines=raw.splitlines()
chunks=["\\n".join(lines[:6000]),"\\n".join(lines[6000:])]
hs=[await rlm.spawn("Count the records in this context. Reply with only the integer.",context=chunk) for chunk in chunks]
rs=await rlm.gather(hs)
await rlm.final({{"bytes_loaded":len(raw.encode()),"records":len(lines),"statuses":[r["status"] for r in rs],"answers":[r["text"] for r in rs]}})'''
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
