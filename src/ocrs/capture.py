"""Bounded image validation and explicit, non-recursive inbox import."""

from __future__ import annotations

import hashlib
import io
import os
import stat
import threading
import warnings
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict

from PIL import Image, UnidentifiedImageError

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
_FORMATS = {
    "PNG": ("image/png", ".png"),
    "JPEG": ("image/jpeg", ".jpg"),
    "WEBP": ("image/webp", ".webp"),
}
_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp"})


class CaptureError(ValueError):
    """A stable, non-sensitive capture error suitable for an API boundary."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class ImageInfo:
    mime: str
    extension: str
    width: int
    height: int
    sha256: str


def validate_image(
    data: bytes,
    max_bytes: int = MAX_IMAGE_BYTES,
    max_pixels: int = MAX_IMAGE_PIXELS,
) -> ImageInfo:
    """Fully decode a static PNG/JPEG/WebP without trusting a filename or MIME."""
    if max_bytes < 1 or max_pixels < 1:
        raise ValueError("Image limits must be positive.")
    if not isinstance(data, bytes) or not data:
        raise CaptureError("image_invalid", "A nonempty image is required.")
    if len(data) > max_bytes:
        raise CaptureError("image_too_large", "The image exceeds the byte limit.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                if image.format not in _FORMATS:
                    raise CaptureError("image_type_unsupported", "Use PNG, JPEG or WebP.")
                mime, extension = _FORMATS[image.format]
                width, height = image.size
                if width <= 0 or height <= 0 or width * height > max_pixels:
                    raise CaptureError(
                        "image_too_many_pixels", "The image exceeds the pixel limit."
                    )
                if getattr(image, "n_frames", 1) != 1:
                    raise CaptureError("image_animated", "Animated images are not supported.")
                image.verify()
            # verify() alone does not decode compressed pixel data in every format.
            with Image.open(io.BytesIO(data)) as image:
                image.load()
    except (Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise CaptureError("image_too_many_pixels", "The image exceeds the pixel limit.") from exc
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, EOFError) as exc:
        if isinstance(exc, CaptureError):
            raise
        raise CaptureError("image_invalid", "The image is invalid or incomplete.") from exc
    return ImageInfo(mime, extension, width, height, hashlib.sha256(data).hexdigest())


class ScanFailure(TypedDict):
    filename: str
    code: str


class ScanSummary(TypedDict):
    imported: int
    pending: int
    skipped: int
    errors: list[ScanFailure]


@dataclass
class _SeenFile:
    signature: tuple[int, ...]
    scans: int = 1
    attempts: int = 0
    complete: bool = False


def _signature(info: os.stat_result) -> tuple[int, ...]:
    return (
        info.st_dev,
        info.st_ino,
        info.st_mode,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def _unsafe_link(info: os.stat_result) -> bool:
    # Windows junctions and other reparse points must be rejected too, even
    # where lstat/is_symlink do not identify them as ordinary symbolic links.
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


class InboxWatcher:
    """Import only explicitly dropped, stable, direct image files.

    No files are moved or deleted. The callback must persist content/source
    deduplication: in-memory tracking intentionally does not claim restart safety.
    Transient callback failures get at most three attempts per unchanged file.
    Replacing or changing a file makes it eligible again after two stable scans.
    """

    def __init__(
        self,
        inbox: Path,
        import_callback: Callable[[bytes, str, str], object],
        *,
        max_bytes: int = MAX_IMAGE_BYTES,
        max_pixels: int = MAX_IMAGE_PIXELS,
        max_files: int = 500,
    ) -> None:
        if max_bytes < 1 or max_pixels < 1 or max_files < 1:
            raise ValueError("Inbox limits must be positive.")
        self.inbox = Path(os.path.abspath(inbox))
        self.import_callback = import_callback
        self.max_bytes = max_bytes
        self.max_pixels = max_pixels
        self.max_files = max_files
        self._seen: dict[str, _SeenFile] = {}
        self._scan_lock = threading.Lock()
        self._cursor = 0
        self._directory_chain: list[tuple[Path, tuple[int, int, int]]] = []

    def _open_directory(self) -> int | None:
        # Check configured ancestors too; never silently adopt a symlinked inbox.
        chain: list[tuple[Path, tuple[int, int, int]]] = []
        for part in (*reversed(self.inbox.parents), self.inbox):
            info = part.lstat()
            if _unsafe_link(info):
                raise CaptureError("inbox_unsafe", "The inbox cannot contain symbolic links.")
            chain.append((part, (info.st_dev, info.st_ino, info.st_mode)))
        self._directory_chain = chain
        before = self.inbox.lstat()
        if not stat.S_ISDIR(before.st_mode):
            raise CaptureError("inbox_unavailable", "The configured inbox is not a directory.")
        if os.scandir not in os.supports_fd or os.open not in os.supports_dir_fd:
            # Windows cannot os.open a directory. The portable branch rechecks
            # every ancestor and directory identity around each bounded read.
            self._check_directory()
            return None
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(self.inbox, flags)
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            os.close(fd)
            raise CaptureError("inbox_changed", "The inbox changed while being opened.")
        return fd

    def _check_directory(self) -> None:
        for part, identity in self._directory_chain:
            info = part.lstat()
            if _unsafe_link(info) or (info.st_dev, info.st_ino, info.st_mode) != identity:
                raise CaptureError("inbox_changed", "The inbox changed during scanning.")

    def scan_once(self) -> ScanSummary:
        """Observe then import stable files; return safe error codes, never paths."""
        summary: ScanSummary = {"imported": 0, "pending": 0, "skipped": 0, "errors": []}
        with self._scan_lock:
            try:
                fd = self._open_directory()
            except (OSError, CaptureError) as exc:
                code = exc.code if isinstance(exc, CaptureError) else "inbox_unavailable"
                summary["errors"].append({"filename": "", "code": code})
                return summary
            try:
                self._scan_directory(fd, summary)
            except (OSError, CaptureError) as exc:
                code = exc.code if isinstance(exc, CaptureError) else "inbox_unavailable"
                summary["errors"].append({"filename": "", "code": code})
            finally:
                if fd is not None:
                    os.close(fd)
        return summary

    def _scan_directory(self, fd: int | None, summary: ScanSummary) -> None:
        # A rotating, bounded batch prevents a large directory from starving files.
        with os.scandir(fd if fd is not None else self.inbox) as entries:
            batch: list[str] = []
            exhausted = True
            for index, entry in enumerate(entries):
                if index < self._cursor:
                    continue
                if len(batch) >= self.max_files:
                    exhausted = False
                    break
                batch.append(entry.name)
        self._cursor = 0 if exhausted else self._cursor + len(batch)
        for name in batch:
            try:
                self._scan_file(fd, name, summary)
            except OSError:
                seen = self._seen.get(name)
                if seen is not None:
                    seen.attempts += 1
                    seen.complete = seen.attempts >= 3
                summary["errors"].append({"filename": name, "code": "inbox_read_failed"})
        # Remove disappeared state without requiring an unbounded directory listing.
        for name in tuple(self._seen):
            try:
                self._stat_file(fd, name)
            except OSError:
                self._seen.pop(name, None)

    def _stat_file(self, fd: int | None, name: str) -> os.stat_result:
        if fd is not None:
            return os.stat(name, dir_fd=fd, follow_symlinks=False)
        return (self.inbox / name).lstat()

    def _scan_file(self, fd: int | None, name: str, summary: ScanSummary) -> None:
        if Path(name).suffix.lower() not in _EXTENSIONS:
            summary["skipped"] += 1
            return
        if fd is None:
            self._check_directory()
        info = self._stat_file(fd, name)
        if not stat.S_ISREG(info.st_mode) or _unsafe_link(info):
            summary["skipped"] += 1
            self._seen.pop(name, None)
            return
        signature = _signature(info)
        seen = self._seen.get(name)
        if seen is None or seen.signature != signature:
            self._seen[name] = _SeenFile(signature)
            summary["pending"] += 1
            return
        seen.scans += 1
        if seen.complete:
            summary["skipped"] += 1
            return
        if info.st_size > self.max_bytes:
            seen.complete = True
            summary["errors"].append({"filename": name, "code": "image_too_large"})
            return
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        file_fd = (
            os.open(name, flags, dir_fd=fd) if fd is not None else os.open(self.inbox / name, flags)
        )
        with os.fdopen(file_fd, "rb") as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or _signature(opened) != signature:
                self._seen.pop(name, None)
                summary["pending"] += 1
                return
            data = stream.read(self.max_bytes + 1)
            after = os.fstat(stream.fileno())
        if (
            _signature(after) != signature
            or len(data) != info.st_size
            or _signature(self._stat_file(fd, name)) != signature
        ):
            self._seen.pop(name, None)
            summary["pending"] += 1
            return
        if fd is None:
            self._check_directory()
        try:
            image = validate_image(data, self.max_bytes, self.max_pixels)
        except CaptureError as exc:
            seen.complete = True
            summary["errors"].append({"filename": name, "code": exc.code})
            return
        try:
            self.import_callback(data, image.mime, f"inbox:{name}")
        except Exception:  # A callback boundary must not abort other independent imports.
            seen.attempts += 1
            seen.complete = seen.attempts >= 3
            summary["errors"].append({"filename": name, "code": "inbox_import_failed"})
            return
        seen.complete = True
        summary["imported"] += 1
