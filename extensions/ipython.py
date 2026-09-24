#!/usr/bin/env python3
"""Pi's interpreter policy for the standalone librlm Jupyter bridge."""
from __future__ import annotations
import os
import sys
from pathlib import Path
from jupyter_client import KernelManager

LIBRLM_ROOT = Path(
    os.environ.get("RLM_LIBRLM_ROOT", Path.home() / "Dev" / "librlm")
).expanduser()
if not LIBRLM_ROOT.is_absolute():
    raise ValueError("RLM_LIBRLM_ROOT must be an absolute checkout path")
LIBRLM_ROOT = LIBRLM_ROOT.resolve()
if not (LIBRLM_ROOT / "rlm" / "bridge.py").is_file():
    raise RuntimeError(
        f"Standalone librlm missing at {LIBRLM_ROOT}; set RLM_LIBRLM_ROOT to its checkout"
    )
sys.path.insert(0, str(LIBRLM_ROOT))
from rlm.bridge import main

if __name__ == "__main__":
    manager = KernelManager(kernel_name="python3")
    # Keep bridge and kernel on the extension-owned Python 3.12 runtime.
    manager.kernel_spec.argv = [
        sys.executable,
        "-m",
        "ipykernel_launcher",
        "-f",
        "{connection_file}",
    ]
    raise SystemExit(main(kernel_manager=manager))
