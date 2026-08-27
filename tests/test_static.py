from __future__ import annotations

import json
from pathlib import Path
import py_compile
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
TS_PATH = ROOT / "extensions" / "rlm.ts"
PY_PATH = ROOT / "extensions" / "ipkl.py"


class StaticPackageTests(unittest.TestCase):
    def test_manifest_loads_exactly_one_extension(self) -> None:
        package = json.loads((ROOT / "package.json").read_text())
        self.assertEqual(package["name"], "pi-ipython-rlm")
        self.assertEqual(package["pi"]["extensions"], ["./extensions/rlm.ts"])

    def test_extension_registers_only_ipython(self) -> None:
        source = TS_PATH.read_text()
        self.assertEqual(source.count("pi.registerTool({"), 1)
        self.assertRegex(source, r'name:\s*"ipython"')

    def test_host_protocol_and_response_limits_match(self) -> None:
        ts = TS_PATH.read_text()
        py = PY_PATH.read_text()
        ts_protocol = re.search(r"HOST_PROTOCOL_VERSION\s*=\s*(\d+)", ts)
        py_protocol = re.search(r"_HOST_PROTOCOL_VERSION\s*=\s*(\d+)", py)
        self.assertIsNotNone(ts_protocol)
        self.assertIsNotNone(py_protocol)
        self.assertEqual(ts_protocol.group(1), py_protocol.group(1))
        self.assertIn("MAX_HOST_RESPONSE_BYTES = 5 * 1024 * 1024", ts)
        self.assertIn("_HOST_RESPONSE_LIMIT = 5 * 1024 * 1024", py)

    def test_python_bridge_compiles(self) -> None:
        py_compile.compile(str(PY_PATH), doraise=True)


if __name__ == "__main__":
    unittest.main()
