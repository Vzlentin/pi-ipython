"""Private, content-addressed checkpoints for the live IPython namespace.

Pickles are executable code. Only load extension-owned, non-symlink files in a
private checkpoint directory. This is branch recovery, not an artifact format.
"""
from __future__ import annotations

import asyncio
import fcntl
import functools
import hashlib
import importlib
import io
import json
import os
import re
import socket
import stat
import sys
import time
import types
import uuid
from pathlib import Path

import cloudpickle

VALUE_LIMIT = 64 * 1024 * 1024
TOTAL_LIMIT = 256 * 1024 * 1024
STORE_LIMIT = 2 * 1024**3
MAX_AGE_SECONDS = 30 * 24 * 60 * 60
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
_BLOB = re.compile(r"[0-9a-f]{64}")
_shell = None
_baseline: set[str] = set()
_directory: Path | None = None


def initialize(shell, directory: str):
    global _shell, _baseline, _directory
    base = Path(directory)
    root = base / "pi-ipython" / "checkpoints"
    for path in (root.parent, root, root / "blobs", root / "manifests"):
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
        _check(path, directory=True)
    _shell = shell
    _baseline = set(shell.user_ns) | set(shell.user_ns_hidden)
    _directory = root
    _root()
    return None


def _check(path: Path, directory=False):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError(f"refusing symlink or unowned path: {path}")
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(info.st_mode):
        raise ValueError(f"unexpected file type: {path}")
    if info.st_mode & 0o077:
        raise ValueError(f"checkpoint path is not private: {path}")
    return info


def _directory_fd(path: Path):
    # Pin every ancestor and refuse symlink traversal before opening pickle data.
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError(f"refusing unowned or non-private directory: {path}")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _root():
    assert _directory is not None
    _check(_directory, directory=True)
    fd = _directory_fd(_directory)
    os.close(fd)
    return _directory


def _open(path: Path, flags: int):
    parent = _directory_fd(path.parent)
    try:
        fd = os.open(path.name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError(f"refusing unsafe checkpoint file: {path}")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _locked(operation):
    @functools.wraps(operation)
    def run(*args, **kwargs):
        fd = _open(_root() / "lock", os.O_RDWR | os.O_CREAT)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            return operation(*args, **kwargs)
        finally:
            os.close(fd)
    return run


def _fsync_directory(path: Path):
    fd = _directory_fd(path)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_write(path: Path, data: bytes):
    temporary = path.parent / f".tmp-{uuid.uuid4().hex}"
    try:
        fd = _open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        with os.fdopen(fd, "wb") as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _read(path: Path, limit: int):
    if _check(path).st_size > limit:
        raise ValueError(f"checkpoint file exceeds {limit} bytes")
    fd = _open(path, os.O_RDONLY)
    with os.fdopen(fd, "rb") as file:
        return file.read(limit + 1)


def _read_manifest(checkpoint_id: str):
    path = _root() / "manifests" / f"{checkpoint_id}.json"
    manifest = json.loads(_read(path, 4 * 1024 * 1024))
    if manifest.get("version") != 2 or not isinstance(manifest.get("saved"), list):
        raise ValueError("invalid checkpoint manifest")
    if not isinstance(manifest.get("skipped"), dict) or not isinstance(manifest.get("cell"), int):
        raise ValueError("invalid checkpoint entries")
    return path, manifest


def _cell_function(value):
    return isinstance(value, types.FunctionType) and (
        value.__module__ == "__main__" or value.__code__.co_filename.startswith("<ipython-input-")
    )


def _make_cell_function(code, _globals, name, defaults, closure):
    # Bind at construction: this also covers functions nested in containers and __setstate__.
    return types.FunctionType(code, _shell.user_ns, name, defaults, closure)


class StatePickler(cloudpickle.CloudPickler):
    def reducer_override(self, value):
        # Nested resources must not become plausible but dead copies.
        cls = type(value)
        if isinstance(value, io.IOBase) and not isinstance(value, (io.StringIO, io.BytesIO)):
            raise TypeError("live file resource")
        if isinstance(value, (asyncio.Future, types.GeneratorType, types.AsyncGeneratorType,
                              types.CoroutineType, socket.socket)):
            raise TypeError(f"live {cls.__name__}")
        return super().reducer_override(value)

    def _function_reduce(self, function):
        if _cell_function(function):
            reduction = self._dynamic_function_reduce(function)
            state, slots = reduction[2]
            slots["__globals__"] = {}
            slots["_cloudpickle_submodules"] = []
            return (_make_cell_function, reduction[1], (state, slots), *reduction[3:])
        return super()._function_reduce(function)


class LimitedWriter:
    def __init__(self, file, limit, message):
        self.file, self.limit, self.message, self.size = file, limit, message, 0

    def write(self, data):
        buffer = memoryview(data)
        if self.size + buffer.nbytes > self.limit:
            raise ValueError(self.message)
        self.size += buffer.nbytes
        return self.file.write(buffer)


def _estimate(value):
    size = sys.getsizeof(value)
    nbytes = getattr(value, "nbytes", None)
    if isinstance(nbytes, (int, float)):
        size = max(size, nbytes)
    memory_usage = getattr(value, "memory_usage", None)
    if callable(memory_usage):
        usage = memory_usage(deep=False)
        if hasattr(usage, "sum"):
            usage = usage.sum()
        size = max(size, int(usage))
    return size


def _eligible(name: str):
    return not name.startswith("_") and name not in _baseline and name not in _shell.user_ns_hidden


def _manifest_records(root: Path):
    records = []
    for name in os.listdir(root / "manifests"):
        match = re.fullmatch(r"([0-9a-f-]{36})\.json", name)
        if not match or not _UUID.fullmatch(match.group(1)):
            continue
        path = root / "manifests" / name
        try:
            info = _check(path)
            _, manifest = _read_manifest(match.group(1))
            records.append({"id": match.group(1), "path": path, "size": info.st_size,
                            "mtime": info.st_mtime, "manifest": manifest})
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    return records


def _blob_sizes(root: Path):
    sizes = {}
    for name in os.listdir(root / "blobs"):
        if not _BLOB.fullmatch(name):
            continue
        try:
            sizes[name] = _check(root / "blobs" / name).st_size
        except (OSError, ValueError):
            pass
    return sizes


def _references(records):
    return {
        entry["blob"]
        for record in records
        for entry in record["manifest"]["saved"]
        if entry.get("kind") == "value" and isinstance(entry.get("blob"), str)
    }


def _cleanup(root: Path, current_id: str, store_limit: int, max_age_seconds: float):
    # A global lock and O(store) GC per save are deliberately simple. Add per-blob
    # pins or a GC stamp file if checkpoint save durations show this is costly.
    records = _manifest_records(root)
    blobs = _blob_sizes(root)
    kept = list(records)
    now = time.time()

    def size():
        references = _references(kept)
        return sum(record["size"] for record in kept) + sum(
            bytes_ for digest, bytes_ in blobs.items() if digest in references
        )

    for record in sorted(records, key=lambda item: item["mtime"]):
        if record["id"] == current_id:
            continue
        if now - record["mtime"] > max_age_seconds or size() > store_limit:
            kept.remove(record)
            record["path"].unlink()
    referenced = _references(kept)
    for digest in blobs:
        if digest not in referenced:
            (root / "blobs" / digest).unlink()
    _fsync_directory(root / "manifests")
    _fsync_directory(root / "blobs")


@_locked
def save(checkpoint_id: str, store_limit: int = STORE_LIMIT, max_age_seconds: float = MAX_AGE_SECONDS):
    if not isinstance(checkpoint_id, str) or not _UUID.fullmatch(checkpoint_id):
        raise ValueError("invalid checkpoint id")
    began = time.monotonic()
    root = _root()
    saved, skipped, total = [], {}, 0
    for name, value in list(_shell.user_ns.items()):
        if not _eligible(name):
            continue
        try:
            if isinstance(value, types.ModuleType):
                saved.append({"name": name, "kind": "module", "module": value.__name__})
                continue
            if _estimate(value) > VALUE_LIMIT:
                raise ValueError("value exceeds 64 MB (size estimate)")
            buffer = io.BytesIO()
            writer = LimitedWriter(buffer, VALUE_LIMIT, "value exceeds 64 MB")
            StatePickler(writer, protocol=5).dump(value)
            if total + writer.size > TOTAL_LIMIT:
                raise ValueError("checkpoint full")
            data = buffer.getbuffer()
            digest = hashlib.sha256(data).hexdigest()
            blob = root / "blobs" / digest
            if os.path.lexists(blob):
                _check(blob)
            else:
                _atomic_write(blob, data)
            total += writer.size
            saved.append({"name": name, "kind": "value", "blob": digest, "bytes": writer.size})
        except Exception as error:
            skipped[name] = f"{type(error).__name__}: {str(error)[:300]}"
    manifest = {
        "version": 2,
        "cell": max(0, _shell.execution_count - 1),
        "saved": saved,
        "skipped": skipped,
        "bytes": total,
        "duration": time.monotonic() - began,
    }
    manifest_path = root / "manifests" / f"{checkpoint_id}.json"
    if os.path.lexists(manifest_path):
        _check(manifest_path)
    _atomic_write(manifest_path, json.dumps(manifest, separators=(",", ":")).encode())
    _cleanup(root, checkpoint_id, max(0, int(store_limit)), max(0, float(max_age_seconds)))
    return {"duration": time.monotonic() - began, "skipped": skipped}


def _clear():
    for name in list(_shell.user_ns):
        if _eligible(name):
            _shell.user_ns.pop(name, None)


@_locked
def restore(candidate_ids):
    if not isinstance(candidate_ids, list):
        raise ValueError("checkpoint candidates must be a list")
    candidates = [value for value in candidate_ids if isinstance(value, str) and _UUID.fullmatch(value)]
    selected = None
    for checkpoint_id in candidates:
        try:
            selected = (checkpoint_id, *_read_manifest(checkpoint_id))
            break
        except (OSError, ValueError, json.JSONDecodeError, KeyError, TypeError):
            continue
    _clear()
    if selected is None:
        return {"id": None, "cell": None, "restored": [], "skipped": {},
                "fellBack": bool(candidate_ids)}

    checkpoint_id, manifest_path, manifest = selected
    os.utime(manifest_path, None, follow_symlinks=False)
    summary = {
        "id": checkpoint_id,
        "cell": manifest["cell"],
        "restored": [],
        "skipped": dict(manifest["skipped"]),
        "fellBack": not candidate_ids or checkpoint_id != candidate_ids[0],
    }
    entries = sorted(manifest["saved"], key=lambda item: item.get("kind") != "module")
    for entry in entries:
        name = entry.get("name")
        if not isinstance(name, str) or not _eligible(name):
            continue
        try:
            if entry.get("kind") == "module":
                module = entry.get("module")
                if not isinstance(module, str):
                    raise ValueError("invalid module entry")
                value = importlib.import_module(module)
            elif entry.get("kind") == "value":
                digest = entry.get("blob")
                if not isinstance(digest, str) or not _BLOB.fullmatch(digest):
                    raise ValueError("invalid blob id")
                data = _read(_root() / "blobs" / digest, VALUE_LIMIT)
                value = cloudpickle.loads(data)
            else:
                raise ValueError("invalid checkpoint entry")
            _shell.user_ns[name] = value
            summary["restored"].append(name)
        except Exception as error:
            summary["skipped"][name] = f"restore failed: {type(error).__name__}: {str(error)[:300]}"
    return summary
