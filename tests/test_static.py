from __future__ import annotations

import json
import py_compile
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TS_PATH = ROOT / "extensions" / "rlm.ts"
CHILD_TS_PATH = ROOT / "extensions" / "child-completion.ts"
HOST_TS_PATH = ROOT / "extensions" / "rlm-host.ts"
KERNEL_TS_PATH = ROOT / "extensions" / "kernel-runtime.ts"
PY_PATH = ROOT / "extensions" / "ipython.py"
LIBRLM_ASYNC_PATH = ROOT / "librlm" / "rlm" / "environments" / "ipython_async.py"
LIBRLM_CHILD_EXECUTION_PATH = ROOT / "librlm" / "rlm" / "core" / "child_execution.py"
LIBRLM_CLIENT_PATH = ROOT / "librlm" / "rlm" / "environments" / "ipython_client.py"
LIBRLM_KERNEL_PATH = ROOT / "librlm" / "rlm" / "environments" / "ipython_kernel.py"
LIBRLM_PROTOCOL_PATH = ROOT / "librlm" / "rlm" / "environments" / "ipython_protocol.py"
LIBRLM_TRANSPORT_PATH = ROOT / "librlm" / "rlm" / "environments" / "ipython_transport.py"


class StaticPackageTests(unittest.TestCase):
    def test_manifest_loads_exactly_one_extension(self) -> None:
        package = json.loads((ROOT / "package.json").read_text())
        self.assertEqual(package["name"], "pi-ipython-rlm")
        self.assertEqual(package["pi"]["extensions"], ["./extensions/rlm.ts"])

    def test_cells_view_and_tool_wiring(self) -> None:
        subprocess.run(
            ["node", "--no-warnings", str(ROOT / "tests" / "test_cells.mjs")],
            cwd=ROOT,
            check=True,
        )

    def test_extension_registers_only_ipython(self) -> None:
        source = TS_PATH.read_text()
        self.assertEqual(source.count("pi.registerTool({"), 1)
        self.assertRegex(source, r'name:\s*"ipython"')

    def test_host_protocol_and_response_limits_match(self) -> None:
        host = HOST_TS_PATH.read_text()
        kernel = KERNEL_TS_PATH.read_text()
        py = PY_PATH.read_text()
        protocol = LIBRLM_PROTOCOL_PATH.read_text()
        ts_protocol = re.search(r"HOST_PROTOCOL_VERSION\s*=\s*(\d+)", host)
        py_protocol = re.search(r"_HOST_PROTOCOL_VERSION\s*=\s*(\d+)", py)
        internal_protocol = re.search(r"^PROTOCOL_VERSION\s*=\s*(\d+)", protocol, re.MULTILINE)
        ts_bridge_protocol = re.search(r"BRIDGE_PROTOCOL_VERSION\s*=\s*(\d+)", kernel)
        py_bridge_protocol = re.search(r"_BRIDGE_PROTOCOL_VERSION\s*=\s*(\d+)", py)
        self.assertIsNotNone(ts_protocol)
        self.assertIsNotNone(py_protocol)
        self.assertIsNotNone(internal_protocol)
        self.assertIsNotNone(ts_bridge_protocol)
        self.assertIsNotNone(py_bridge_protocol)
        self.assertEqual(ts_protocol.group(1), py_protocol.group(1))
        self.assertEqual(ts_protocol.group(1), "2")
        self.assertEqual(ts_bridge_protocol.group(1), py_bridge_protocol.group(1))
        self.assertEqual(ts_bridge_protocol.group(1), "6")
        self.assertEqual(internal_protocol.group(1), "5")
        self.assertNotEqual(internal_protocol.group(1), ts_protocol.group(1))
        self.assertIn("MAX_HOST_RESPONSE_BYTES = 5 * 1024 * 1024", host)
        self.assertIn("_HOST_RESPONSE_LIMIT = 5 * 1024 * 1024", py)
        transport = LIBRLM_TRANSPORT_PATH.read_text()
        self.assertIn("DEFAULT_MAX_MESSAGE_BYTES = 5 * 1024 * 1024", transport)
        self.assertIn("MAX_CHILD_REQUEST_BYTES = 1024 * 1024", host)
        self.assertIn("_DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024", LIBRLM_ASYNC_PATH.read_text())
        self.assertIn("_HOST_TIMEOUT_SECONDS = 310", py)
        self.assertIn("DEFAULT_REQUEST_TIMEOUT = 310.0", transport)

    def test_viewer_connection_file_is_host_only(self) -> None:
        kernel = KERNEL_TS_PATH.read_text()
        bridge = PY_PATH.read_text()
        self.assertIn('"connection_file": str(Path(manager.connection_file).resolve())', bridge)
        self.assertIn('typeof message.connection_file !== "string"', kernel)
        self.assertIn("!isAbsolute(message.connection_file)", kernel)
        self.assertIn("this.kernelConnectionFile = undefined", kernel)
        self.assertNotIn("connectionFile:", TS_PATH.read_text())

    def test_async_primitives_are_owned_by_librlm(self) -> None:
        host = HOST_TS_PATH.read_text()
        client = LIBRLM_CLIENT_PATH.read_text()
        self.assertIn('op: "complete"', host)
        self.assertNotIn('op: "spawn"', host)
        self.assertNotIn('op: "gather"', host)
        self.assertNotIn('op: "final"', host)
        self.assertIn("async def spawn", client)
        self.assertIn("async def gather", client)
        self.assertIn("async def release", client)
        self.assertIn("async def final", client)
        self.assertNotIn('"op": "gather_commit"', client)

    def test_internal_transport_owns_channel_and_framing(self) -> None:
        protocol = LIBRLM_PROTOCOL_PATH.read_text()
        transport = LIBRLM_TRANSPORT_PATH.read_text()
        self.assertIn("class HostChannel", transport)
        self.assertIn('struct.pack(">I"', transport)
        self.assertIn("readexactly(4)", transport)
        self.assertIn("hmac.compare_digest", transport)
        for forbidden in (
            "import socket",
            "import struct",
            "import hmac",
            "class HostChannel",
            "DEFAULT_MAX_MESSAGE_BYTES",
            "DEFAULT_REQUEST_TIMEOUT",
        ):
            self.assertNotIn(forbidden, protocol)
        for path in (LIBRLM_ASYNC_PATH, LIBRLM_CLIENT_PATH):
            source = path.read_text()
            self.assertNotIn('struct.pack(">I"', source)
            self.assertNotIn("readexactly(4)", source)

    def test_internal_failures_use_typed_protocol_state(self) -> None:
        host = LIBRLM_ASYNC_PATH.read_text()
        client = LIBRLM_CLIENT_PATH.read_text()
        protocol = LIBRLM_PROTOCOL_PATH.read_text()
        transport = LIBRLM_TRANSPORT_PATH.read_text()
        self.assertIn('"error_code": code.value', transport)
        self.assertIn("FailureCode.GATHER_PENDING", host)
        self.assertIn("FailureCode.GATHER_PENDING", transport)
        self.assertNotIn("OPERATION_REGISTRY", protocol)
        self.assertIn("match request:", host)
        self.assertIn("case QueryRequest():", host)
        self.assertIn("ValidateRequest(", client)
        self.assertNotIn("gather request is still pending", client)
        self.assertNotIn("No rlm query runner configured", client)

    def test_kernel_bootstrap_uses_the_canonical_client_interface(self) -> None:
        bridge = PY_PATH.read_text()
        client = LIBRLM_CLIENT_PATH.read_text()
        self.assertIn("install_kernel_runtime as _pi_install_rlm", bridge)
        self.assertIn("_pi_rlm_client = _pi_install_rlm", bridge)
        self.assertNotIn("_pi_rlm_client.prepare_execution", bridge)
        protocol = LIBRLM_PROTOCOL_PATH.read_text()
        transport = LIBRLM_TRANSPORT_PATH.read_text()
        self.assertIn("def retry_on_disconnect", protocol)
        self.assertNotIn("OPERATION_REGISTRY", protocol)
        self.assertIn("class HostChannel", transport)
        self.assertIn("from rlm.environments.ipython_transport import (", client)
        self.assertIn("    HostChannel,", client)
        self.assertNotIn("class ProtocolCodec", protocol)
        self.assertNotIn("class ProtocolCodec", client)
        self.assertNotIn("def _request_sync", client)
        self.assertNotIn("async def _request", client)
        self.assertIn("self.channel.request_sync(", client)
        self.assertIn("await self.channel.request(", client)
        self.assertNotIn("isinstance(response, UnitResult)", client)
        self.assertIn("child = _LIBRLM.ChildResult.from_wire(result)", bridge)
        self.assertIn("return _LIBRLM.ChildOutcome.external(", bridge)

    def test_child_request_disconnect_cancels_the_model_request(self) -> None:
        source = HOST_TS_PATH.read_text()
        self.assertIn('socket.once("end", disconnect)', source)
        self.assertIn('requesterSignal.addEventListener("abort", cancelOnDisconnect', source)
        self.assertIn('record.controller.abort(new Error("Child requester disconnected"))', source)
        self.assertIn("signal: record.controller.signal", source)
        self.assertNotIn("session?.dispose()", source)

    def test_children_use_the_public_direct_completion_seam(self) -> None:
        child_completion = CHILD_TS_PATH.read_text()
        extension_source = "\n".join(
            path.read_text() for path in (TS_PATH, CHILD_TS_PATH, HOST_TS_PATH, KERNEL_TS_PATH)
        )
        self.assertIn("modelRegistry.complete(", child_completion)
        self.assertIn("Unsupported child completion API", child_completion)
        self.assertNotIn("createAgentSession", extension_source)
        self.assertNotIn("DefaultResourceLoader", extension_source)
        self.assertNotIn("SettingsManager", extension_source)
        self.assertNotIn("SessionManager", extension_source)
        self.assertNotIn("as unknown as { runtime:", extension_source)

    def test_child_adapter_failure_has_canonical_zero_usage(self) -> None:
        script = f"""
import importlib.util
import sys
import threading
import types
jupyter_client = types.ModuleType("jupyter_client")
jupyter_client.KernelManager = object
sys.modules["jupyter_client"] = jupyter_client
spec = importlib.util.spec_from_file_location("pi_ipython_bridge", {str(PY_PATH)!r})
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
def fail(_request, _cancel):
    raise RuntimeError("transport failed")
bridge._request_pi_child = fail
outcome = bridge.request_pi_child(object(), threading.Event())
assert outcome.status == "error"
assert outcome.usage_json == bridge.empty_pi_usage()
"""
        subprocess.run([sys.executable, "-I", "-c", script], check=True)

    def test_each_execute_applies_the_active_absolute_cwd(self) -> None:
        kernel = KERNEL_TS_PATH.read_text()
        bridge = PY_PATH.read_text()
        self.assertIn("code, cwd: config.cwd", kernel)
        self.assertIn("bootstrap_code(host.address, host.auth_token, request_id, cwd)", bridge)
        self.assertIn("not os.path.isabs(request_cwd) or not os.path.isdir(request_cwd)", bridge)
        self.assertIn("working_dir={working_dir!r}", bridge)

    def test_librlm_primitive_imports_under_isolated_python(self) -> None:
        script = (
            "import sys; "
            f"sys.path.insert(0, {str(ROOT / 'librlm')!r}); "
            "from rlm.environments.ipython_async import AsyncRLMHost, ChildExecution, RLMClient"
        )
        subprocess.run([sys.executable, "-I", "-c", script], check=True)

    def test_python_bridge_and_librlm_primitive_compile(self) -> None:
        py_compile.compile(str(PY_PATH), doraise=True)
        py_compile.compile(str(LIBRLM_ASYNC_PATH), doraise=True)
        py_compile.compile(str(LIBRLM_CHILD_EXECUTION_PATH), doraise=True)
        py_compile.compile(str(LIBRLM_CLIENT_PATH), doraise=True)
        py_compile.compile(str(LIBRLM_KERNEL_PATH), doraise=True)
        py_compile.compile(str(LIBRLM_PROTOCOL_PATH), doraise=True)
        py_compile.compile(str(LIBRLM_TRANSPORT_PATH), doraise=True)


if __name__ == "__main__":
    unittest.main()
