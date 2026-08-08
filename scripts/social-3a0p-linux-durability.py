#!/usr/bin/env python3
"""Isolated Linux durability and O_NOFOLLOW proof.

The program accepts one small JSON object on stdin and emits only a fixed,
sanitized JSON result. It never reports paths or exception text.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import uuid
from typing import Any


_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_FILESYSTEM_RE = re.compile(r"^[A-Za-z0-9._+-]{1,64}$")
_OPEN_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
_OPEN_FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW
_EXPECTED_LINK_ERRNOS = frozenset(
    value
    for value in (
        getattr(errno, "ELOOP", None),
        getattr(errno, "ENOTDIR", None),
    )
    if isinstance(value, int)
)


class ProofFailure(Exception):
    """Controlled failure without externally useful exception text."""


def _fail() -> None:
    raise ProofFailure()


def _component(name: str) -> str:
    if not isinstance(name, str) or not _NAME_RE.fullmatch(name):
        _fail()
    if name in (".", ".."):
        _fail()
    return name


def _absolute_components(raw_path: Any) -> list[str]:
    if not isinstance(raw_path, str) or not raw_path or "\x00" in raw_path:
        _fail()
    if not os.path.isabs(raw_path) or os.path.normpath(raw_path) != raw_path:
        _fail()
    drive, tail = os.path.splitdrive(raw_path)
    if drive or not tail.startswith(os.sep):
        _fail()
    return [_component(part) for part in tail.split(os.sep) if part]


def _open_absolute_directory(raw_path: str) -> int:
    """Open every existing component relative to a held, no-follow fd."""

    descriptor = os.open(os.sep, _OPEN_DIRECTORY_FLAGS)
    try:
        for component in _absolute_components(raw_path):
            next_descriptor = os.open(
                component,
                _OPEN_DIRECTORY_FLAGS,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = next_descriptor
        opened = os.fstat(descriptor)
        if not stat.S_ISDIR(opened.st_mode):
            _fail()
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _identity(metadata: os.stat_result) -> tuple[int, int]:
    return (metadata.st_dev, metadata.st_ino)


def _open_directory_at(
    parent_fd: int,
    name: str,
    expected_identity: tuple[int, int] | None = None,
) -> int:
    descriptor = os.open(
        _component(name),
        _OPEN_DIRECTORY_FLAGS,
        dir_fd=parent_fd,
    )
    opened = os.fstat(descriptor)
    if (
        not stat.S_ISDIR(opened.st_mode)
        or (expected_identity is not None and _identity(opened) != expected_identity)
    ):
        os.close(descriptor)
        _fail()
    return descriptor


def _open_regular_at(
    parent_fd: int,
    name: str,
    expected_identity: tuple[int, int] | None = None,
) -> int:
    descriptor = os.open(
        _component(name),
        _OPEN_FILE_FLAGS,
        dir_fd=parent_fd,
    )
    opened = os.fstat(descriptor)
    if (
        not stat.S_ISREG(opened.st_mode)
        or (expected_identity is not None and _identity(opened) != expected_identity)
    ):
        os.close(descriptor)
        _fail()
    return descriptor


def _write_all(descriptor: int, payload: bytes) -> bool:
    offset = 0
    while offset < len(payload):
        written = os.write(descriptor, payload[offset:])
        if not isinstance(written, int) or written <= 0:
            _fail()
        offset += written
    return offset == len(payload)


def _sha256_from_descriptor(descriptor: int) -> str:
    digest = hashlib.sha256()
    while True:
        chunk = os.read(descriptor, 64 * 1024)
        if not chunk:
            return digest.hexdigest()
        digest.update(chunk)


def _expect_link_refusal(operation: Any) -> bool:
    try:
        descriptor = operation()
    except OSError as error:
        return error.errno in _EXPECTED_LINK_ERRNOS
    else:
        os.close(descriptor)
        return False


def _unlink_expected(parent_fd: int, name: str, expected_mode: str) -> None:
    component = _component(name)
    metadata = os.stat(component, dir_fd=parent_fd, follow_symlinks=False)
    if expected_mode == "file" and not stat.S_ISREG(metadata.st_mode):
        _fail()
    if expected_mode == "link" and not stat.S_ISLNK(metadata.st_mode):
        _fail()
    os.unlink(component, dir_fd=parent_fd)


def _remove_empty_directory(
    parent_fd: int,
    name: str,
    expected_identity: tuple[int, int] | None = None,
) -> None:
    child = _open_directory_at(parent_fd, name, expected_identity)
    try:
        if os.listdir(child):
            _fail()
    finally:
        os.close(child)
    os.rmdir(_component(name), dir_fd=parent_fd)


def _directory_is_absent(parent_fd: int, name: str) -> bool:
    try:
        os.stat(_component(name), dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return True
    return False


def _filesystem_name(raw_path: str) -> str:
    completed = subprocess.run(
        ["stat", "-f", "-c", "%T", "--", raw_path],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
        timeout=5,
        env={"LC_ALL": "C", "LANG": "C", "PATH": "/usr/bin:/bin"},
    )
    # Coreutils reports ext filesystems as ``ext2/ext3``. Preserve the useful
    # classification while keeping the emitted value path-free.
    candidate = completed.stdout.strip().replace("/", "-")
    if completed.returncode != 0 or not _FILESYSTEM_RE.fullmatch(candidate):
        _fail()
    return candidate


def _proof(runner_temp: str) -> dict[str, Any]:
    runner_fd = _open_absolute_directory(runner_temp)
    owned_name = ".ia4tube-social3a0p-linux-durability-" + uuid.uuid4().hex
    owned_fd: int | None = None
    owned_identity: tuple[int, int] | None = None
    outside_identity: tuple[int, int] | None = None
    cleanup_completed = False
    payload = b"IA4Tube synthetic Linux durability proof v1\n"
    expected_sha256 = hashlib.sha256(payload).hexdigest()

    created_names: dict[str, str] = {}
    created_directories: list[str] = []
    try:
        os.mkdir(owned_name, mode=0o700, dir_fd=runner_fd)
        created_directories.append(owned_name)
        owned_fd = _open_directory_at(runner_fd, owned_name)
        owned_metadata = os.fstat(owned_fd)
        owned_identity = _identity(owned_metadata)
        if (owned_metadata.st_mode & 0o077) != 0:
            _fail()

        filesystem = _filesystem_name(os.path.join(runner_temp, owned_name))

        temporary_name = "durability.tmp"
        final_name = "durability.bin"
        descriptor = os.open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=owned_fd,
        )
        durability_identity = _identity(os.fstat(descriptor))
        created_names[temporary_name] = "file"
        create_exclusive = True
        file_closed = False
        try:
            full_write = _write_all(descriptor, payload)
            os.fsync(descriptor)
            file_fsync = True
        finally:
            os.close(descriptor)
            file_closed = True

        os.rename(
            temporary_name,
            final_name,
            src_dir_fd=owned_fd,
            dst_dir_fd=owned_fd,
        )
        created_names.pop(temporary_name)
        created_names[final_name] = "file"
        atomic_rename = True

        parent_descriptor = _open_directory_at(
            runner_fd,
            owned_name,
            owned_identity,
        )
        parent_opened = True
        parent_closed = False
        try:
            os.fsync(parent_descriptor)
            directory_fsync = True
        finally:
            os.close(parent_descriptor)
            parent_closed = True

        os.close(owned_fd)
        owned_fd = None
        reopened_parent = _open_directory_at(runner_fd, owned_name, owned_identity)
        try:
            reopened = _open_regular_at(
                reopened_parent,
                final_name,
                durability_identity,
            )
            try:
                reopened_sha256 = _sha256_from_descriptor(reopened)
            finally:
                os.close(reopened)
        finally:
            os.close(reopened_parent)
        reopened_no_follow = True
        sha256_match = reopened_sha256 == expected_sha256
        if not sha256_match:
            _fail()

        owned_fd = _open_directory_at(runner_fd, owned_name, owned_identity)

        regular_name = "regular.bin"
        regular_descriptor = os.open(
            regular_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=owned_fd,
        )
        created_names[regular_name] = "file"
        try:
            _write_all(regular_descriptor, b"regular synthetic fixture\n")
            os.fsync(regular_descriptor)
        finally:
            os.close(regular_descriptor)
        regular_read = _open_regular_at(owned_fd, regular_name)
        os.close(regular_read)
        regular_accepted = True

        outside_name = "outside"
        os.mkdir(outside_name, mode=0o700, dir_fd=owned_fd)
        created_directories.append(outside_name)
        outside_fd = _open_directory_at(owned_fd, outside_name)
        outside_identity = _identity(os.fstat(outside_fd))
        try:
            sentinel_name = "sentinel.bin"
            sentinel = os.open(
                sentinel_name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=outside_fd,
            )
            try:
                _write_all(sentinel, b"must never be traversed\n")
                os.fsync(sentinel)
            finally:
                os.close(sentinel)
        finally:
            os.close(outside_fd)

        final_link = "final-link"
        os.symlink(
            os.path.join(outside_name, sentinel_name),
            final_link,
            dir_fd=owned_fd,
        )
        created_names[final_link] = "link"
        final_symlink_rejected = _expect_link_refusal(
            lambda: _open_regular_at(owned_fd, final_link)
        )

        swapped_name = "swapped.bin"
        swapped = os.open(
            swapped_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=owned_fd,
        )
        created_names[swapped_name] = "file"
        os.close(swapped)
        os.unlink(swapped_name, dir_fd=owned_fd)
        created_names.pop(swapped_name)
        os.symlink(
            os.path.join(outside_name, sentinel_name),
            swapped_name,
            dir_fd=owned_fd,
        )
        created_names[swapped_name] = "link"
        swapped_rejected = _expect_link_refusal(
            lambda: _open_regular_at(owned_fd, swapped_name)
        )

        intermediate_link = "intermediate-link"
        os.symlink(outside_name, intermediate_link, dir_fd=owned_fd)
        created_names[intermediate_link] = "link"
        intermediate_rejected = _expect_link_refusal(
            lambda: _open_directory_at(owned_fd, intermediate_link)
        )

        no_follow_values = (
            regular_accepted,
            final_symlink_rejected,
            swapped_rejected,
            intermediate_rejected,
        )
        if not all(no_follow_values):
            _fail()
        never_traversed = all(
            (final_symlink_rejected, swapped_rejected, intermediate_rejected)
        )

        # Remove only objects whose kind was independently verified without
        # following links. The outside fixture is removed through held fds.
        for name in (intermediate_link, swapped_name, final_link):
            _unlink_expected(owned_fd, name, "link")
            created_names.pop(name)
        for name in (regular_name, final_name):
            _unlink_expected(owned_fd, name, "file")
            created_names.pop(name)
        outside_fd = _open_directory_at(owned_fd, outside_name, outside_identity)
        try:
            _unlink_expected(outside_fd, sentinel_name, "file")
        finally:
            os.close(outside_fd)
        _remove_empty_directory(owned_fd, outside_name, outside_identity)
        created_directories.remove(outside_name)

        if os.listdir(owned_fd):
            _fail()
        os.close(owned_fd)
        owned_fd = None
        os.rmdir(owned_name, dir_fd=runner_fd)
        created_directories.remove(owned_name)
        cleanup_completed = _directory_is_absent(runner_fd, owned_name)
        if not cleanup_completed:
            _fail()

        result = {
            "ok": True,
            "schemaVersion": 1,
            "directoryFsyncProved": True,
            "noFollowProved": True,
            "symlinkAttackRejected": True,
            "cleanupCompleted": True,
            "cleanupResiduals": 0,
            "filesystem": filesystem,
            "durability": {
                "createExclusive": create_exclusive,
                "fullWrite": full_write,
                "fileFsync": file_fsync,
                "fileClosedBeforeRename": file_closed,
                "atomicRename": atomic_rename,
                "parentDirectoryOpened": parent_opened,
                "directoryFsync": directory_fsync,
                "parentDirectoryClosed": parent_closed,
                "reopenedNoFollow": reopened_no_follow,
                "sha256Match": sha256_match,
            },
            "noFollow": {
                "supported": True,
                "everyComponentProtected": True,
                "regularFileAccepted": regular_accepted,
                "finalSymlinkRejected": final_symlink_rejected,
                "swappedBeforeOpenSymlinkRejected": swapped_rejected,
                "intermediateSymlinkRejected": intermediate_rejected,
                "neverTraversed": never_traversed,
                "errorCodesSanitized": True,
            },
        }
        if not all(
            value
            for section in (result["durability"], result["noFollow"])
            for value in section.values()
            if isinstance(value, bool)
        ):
            _fail()
        return result
    finally:
        if owned_fd is not None:
            try:
                os.close(owned_fd)
            except OSError:
                pass
        # A failed proof deliberately does not perform unsafe recursive path
        # cleanup. It only attempts deletion of names created by this process,
        # with kind checks and held directory descriptors.
        if (
            not cleanup_completed
            and owned_identity is not None
            and not _directory_is_absent(runner_fd, owned_name)
        ):
            recovery_fd: int | None = None
            try:
                recovery_fd = _open_directory_at(runner_fd, owned_name, owned_identity)
                for name, expected_mode in tuple(created_names.items()):
                    try:
                        _unlink_expected(recovery_fd, name, expected_mode)
                    except OSError:
                        pass
                if "outside" in created_directories and outside_identity is not None:
                    try:
                        outside_fd = _open_directory_at(
                            recovery_fd,
                            "outside",
                            outside_identity,
                        )
                        try:
                            try:
                                _unlink_expected(outside_fd, "sentinel.bin", "file")
                            except OSError:
                                pass
                        finally:
                            os.close(outside_fd)
                        _remove_empty_directory(
                            recovery_fd,
                            "outside",
                            outside_identity,
                        )
                    except OSError:
                        pass
                if not os.listdir(recovery_fd):
                    os.close(recovery_fd)
                    recovery_fd = None
                    os.rmdir(owned_name, dir_fd=runner_fd)
            except OSError:
                pass
            finally:
                if recovery_fd is not None:
                    try:
                        os.close(recovery_fd)
                    except OSError:
                        pass
        os.close(runner_fd)


def _main() -> int:
    try:
        if sys.platform != "linux":
            _fail()
        raw = sys.stdin.buffer.read(16 * 1024 + 1)
        if len(raw) > 16 * 1024:
            _fail()
        request = json.loads(raw.decode("utf-8"))
        if not isinstance(request, dict) or set(request) != {"runnerTemp"}:
            _fail()
        result = _proof(request["runnerTemp"])
        sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
        return 0
    except BaseException:
        sys.stderr.write('{"ok":false,"code":"linux_durability_failed"}\n')
        return 1


if __name__ == "__main__":
    raise SystemExit(_main())
