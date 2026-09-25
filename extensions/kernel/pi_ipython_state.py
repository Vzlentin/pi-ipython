"""Private, content-addressed checkpoints for the live IPython namespace.

Pickles are executable code. Only load extension-owned, non-symlink files in a
private checkpoint directory. This is branch recovery, not an artifact format.

Module globals describe this kernel and die with it: its startup names, its
storage, and which checkpoint its namespace currently holds.
"""
from __future__ import annotations

import asyncio
import collections
import contextlib
import fcntl
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
from typing import NamedTuple

import cloudpickle

VALUE_LIMIT = 64 * 1024 * 1024
TOTAL_LIMIT = 256 * 1024 * 1024
STORE_LIMIT = 2 * 1024**3
MAX_AGE_SECONDS = 30 * 24 * 60 * 60
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
_BLOB = re.compile(r"[0-9a-f]{64}")
_LOADING = "loading"
_PARTIAL = object()
_shell = None
_baseline: set[str] = set()
_directory: Path | None = None
_storage_error: str | None = None
_storage_error_reported = False
_held: object = None


class _Store(NamedTuple):
    root: int
    blobs: int
    manifests: int


class _Entry(NamedTuple):
    name: str
    module: str | None
    blob: str | None


class _Manifest(NamedTuple):
    cell: int
    entries: list[_Entry]
    skipped: dict[str, str]
    size: int
    mtime: float

    @property
    def blobs(self) -> set[str]:
        return {entry.blob for entry in self.entries if entry.blob is not None}


def initialize(shell, directory: str):
    """Run once per kernel, after all other startup code. Storage problems are reported by restore."""
    global _shell, _baseline, _directory, _storage_error
    _shell = shell
    _baseline = set(shell.user_ns) | set(shell.user_ns_hidden)
    try:
        fd = _directory_fd(Path(directory))
        try:
            for name in ("pi-ipython", "checkpoints"):
                parent, fd = fd, _subdir(fd, name, create=True)
                os.close(parent)
            for name in ("blobs", "manifests"):
                os.close(_subdir(fd, name, create=True))
        finally:
            os.close(fd)
    except Exception as error:
        _storage_error = f"{type(error).__name__}: {error}"
        return
    _directory = Path(directory) / "pi-ipython" / "checkpoints"


def _private(fd: int, name: str, kind=stat.S_ISDIR):
    info = os.fstat(fd)
    if not kind(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        os.close(fd)
        raise ValueError(f"refusing unsafe, unowned or non-private checkpoint path: {name}")
    return fd


def _directory_fd(path: Path):
    # Pin every ancestor and refuse symlink traversal before opening pickle data.
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            parent, fd = fd, os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(parent)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _subdir(parent: int, name: str, create=False):
    if create:
        with contextlib.suppress(FileExistsError):
            os.mkdir(name, 0o700, dir_fd=parent)
    return _private(os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent), name)


def _open(directory: int, name: str, flags: int):
    fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
    return _private(fd, name, stat.S_ISREG)


@contextlib.contextmanager
def _store():
    # Every file operation is relative to descriptors pinned here, under one store-wide lock.
    if _directory is None:
        raise RuntimeError(f"checkpoint storage unavailable: {_storage_error or 'not initialized'}")
    with contextlib.ExitStack() as stack:
        def pin(fd):
            stack.callback(os.close, fd)
            return fd
        root = pin(_private(_directory_fd(_directory), str(_directory)))
        fcntl.flock(pin(_open(root, "lock", os.O_RDWR | os.O_CREAT)), fcntl.LOCK_EX)
        yield _Store(root, pin(_subdir(root, "blobs")), pin(_subdir(root, "manifests")))


def _atomic_write(directory: int, name: str, data):
    temporary = f".tmp-{uuid.uuid4().hex}"
    try:
        with os.fdopen(_open(directory, temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL), "wb") as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary, dir_fd=directory)


def _read(directory: int, name: str, limit: int):
    with os.fdopen(_open(directory, name, os.O_RDONLY), "rb") as file:
        info = os.fstat(file.fileno())
        if info.st_size > limit:
            raise ValueError(f"checkpoint file exceeds {limit} bytes")
        data = file.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"checkpoint file exceeds {limit} bytes")
    return data, info


def _parse_entry(item) -> _Entry:
    if isinstance(item, dict) and isinstance(item.get("name"), str):
        if item.get("kind") == "module" and isinstance(item.get("module"), str):
            return _Entry(item["name"], item["module"], None)
        if item.get("kind") == "value" and isinstance(item.get("blob"), str) and _BLOB.fullmatch(item["blob"]):
            return _Entry(item["name"], None, item["blob"])
    raise ValueError("invalid checkpoint entry")


def _read_manifest(store: _Store, checkpoint_id: str) -> _Manifest:
    """Raise OSError or ValueError unless the manifest is readable and well formed."""
    data, info = _read(store.manifests, f"{checkpoint_id}.json", 4 * 1024 * 1024)
    manifest = json.loads(data)
    if not isinstance(manifest, dict) or manifest.get("version") != 2:
        raise ValueError("unsupported checkpoint manifest")
    cell, saved, skipped = manifest.get("cell"), manifest.get("saved"), manifest.get("skipped")
    if not isinstance(cell, int) or not isinstance(saved, list) or not isinstance(skipped, dict) \
            or not all(isinstance(reason, str) for reason in skipped.values()):
        raise ValueError("invalid checkpoint manifest")
    return _Manifest(cell, [_parse_entry(item) for item in saved], skipped, info.st_size, info.st_mtime)


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


def _manifests(store: _Store) -> dict[str, _Manifest]:
    manifests = {}
    for name in os.listdir(store.manifests):
        checkpoint_id = name.removesuffix(".json")
        if checkpoint_id == name or not _UUID.fullmatch(checkpoint_id):
            continue
        with contextlib.suppress(OSError, ValueError):
            manifests[checkpoint_id] = _read_manifest(store, checkpoint_id)
    return manifests


def _blob_sizes(store: _Store):
    sizes = {}
    for name in os.listdir(store.blobs):
        if not _BLOB.fullmatch(name):
            continue
        with contextlib.suppress(OSError):
            info = os.stat(name, dir_fd=store.blobs, follow_symlinks=False)
            if stat.S_ISREG(info.st_mode):
                sizes[name] = info.st_size
    return sizes


def _cleanup(store: _Store, current_id: str, store_limit: int, max_age_seconds: float):
    # A global lock and a full store scan per save are deliberately simple. Add a GC
    # stamp file if checkpoint save durations show the scan is costly.
    manifests = _manifests(store)
    blobs = _blob_sizes(store)
    references = collections.Counter(digest for manifest in manifests.values() for digest in manifest.blobs)
    total = sum(manifest.size for manifest in manifests.values()) + sum(blobs.get(digest, 0) for digest in references)
    now = time.time()
    for checkpoint_id, manifest in sorted(manifests.items(), key=lambda item: item[1].mtime):
        if checkpoint_id == current_id:
            continue
        if now - manifest.mtime <= max_age_seconds and total <= store_limit:
            continue
        os.unlink(f"{checkpoint_id}.json", dir_fd=store.manifests)
        total -= manifest.size
        for digest in manifest.blobs:
            references[digest] -= 1
            if not references[digest]:
                del references[digest]
                total -= blobs.get(digest, 0)
    for digest in blobs.keys() - references.keys():
        os.unlink(digest, dir_fd=store.blobs)
    os.fsync(store.manifests)
    os.fsync(store.blobs)


def save(checkpoint_id: str, store_limit: int = STORE_LIMIT, max_age_seconds: float = MAX_AGE_SECONDS):
    """Record the namespace as checkpoint_id. Without storage, which restore reports, only the ID is kept."""
    global _held
    if not isinstance(checkpoint_id, str) or not _UUID.fullmatch(checkpoint_id):
        raise ValueError("invalid checkpoint id")
    _held = checkpoint_id
    if _directory is None:
        return
    began = time.monotonic()
    with _store() as store:
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
                try:
                    os.close(_open(store.blobs, digest, os.O_RDONLY))
                except FileNotFoundError:
                    _atomic_write(store.blobs, digest, data)
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
        _atomic_write(store.manifests, f"{checkpoint_id}.json", json.dumps(manifest, separators=(",", ":")).encode())
        _cleanup(store, checkpoint_id, max(0, int(store_limit)), max(0, float(max_age_seconds)))


def accept(checkpoint_id: str | None):
    """Treat the namespace as checkpoint_id after a restore that did not finish."""
    global _held
    _held = checkpoint_id


def _clear():
    for name in list(_shell.user_ns):
        if _eligible(name):
            _shell.user_ns.pop(name, None)


def _take_crashed(store: _Store):
    """Delete and return the blob whose unpickling killed the previous kernel, if any."""
    try:
        data, _ = _read(store.root, _LOADING, 64)
    except FileNotFoundError:
        return None
    os.unlink(_LOADING, dir_fd=store.root)
    digest = data.decode("ascii", "replace")
    if not _BLOB.fullmatch(digest):
        return None
    with contextlib.suppress(FileNotFoundError):
        os.unlink(digest, dir_fd=store.blobs)
    return digest


def _load(store: _Store, digest: str):
    data, _ = _read(store.blobs, digest, VALUE_LIMIT)
    # The marker outlives this call only if unpickling kills the kernel.
    with os.fdopen(_open(store.root, _LOADING, os.O_WRONLY | os.O_CREAT | os.O_TRUNC), "wb") as file:
        file.write(digest.encode())
    try:
        return cloudpickle.loads(data)
    finally:
        os.unlink(_LOADING, dir_fd=store.root)


def restore(candidate_ids):
    """Replace the namespace with the newest readable checkpoint in candidate_ids (newest first).

    Returns None when the namespace already holds candidate_ids[0], or when unavailable
    storage was already reported. Unpickling runs user __setstate__ code under the
    store-wide lock, so a slow value blocks other sessions until the restore is interrupted.
    """
    global _held, _storage_error_reported
    if not isinstance(candidate_ids, list):
        raise ValueError("checkpoint candidates must be a list")
    nearest = candidate_ids[0] if candidate_ids else None
    if _directory is None:
        if _storage_error_reported:
            return None
        _storage_error_reported = True
        return {"status": "unavailable", "error": _storage_error or "not initialized"}
    if nearest == _held:
        return None
    candidates = [value for value in candidate_ids if isinstance(value, str) and _UUID.fullmatch(value)]
    with _store() as store:
        crashed = _take_crashed(store)
        selected = None
        for checkpoint_id in candidates:
            with contextlib.suppress(OSError, ValueError):
                selected = checkpoint_id, _read_manifest(store, checkpoint_id)
                break
        _held = _PARTIAL
        _clear()
        if selected is None:
            _held = nearest
            return {"status": "empty", "fellBack": bool(candidate_ids)}

        checkpoint_id, manifest = selected
        os.utime(f"{checkpoint_id}.json", dir_fd=store.manifests, follow_symlinks=False)
        restored, skipped = [], dict(manifest.skipped)
        for entry in sorted(manifest.entries, key=lambda entry: entry.module is None):
            if not _eligible(entry.name):
                continue
            try:
                if entry.module is not None:
                    value = importlib.import_module(entry.module)
                elif entry.blob == crashed:
                    raise RuntimeError("restoring this value killed the kernel; it was deleted")
                else:
                    value = _load(store, entry.blob)
                _shell.user_ns[entry.name] = value
                restored.append(entry.name)
            except Exception as error:
                skipped[entry.name] = f"restore failed: {type(error).__name__}: {str(error)[:300]}"
        _held = nearest
        return {
            "status": "restored",
            "id": checkpoint_id,
            "cell": manifest.cell,
            "restored": restored,
            "skipped": skipped,
            "fellBack": checkpoint_id != nearest,
        }
