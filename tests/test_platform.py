"""Cross-platform regressions reproducible without a Windows desktop."""

import os
import stat
from pathlib import Path

import pytest

from ocrs.exporter import write_workbook


def test_export_syncs_a_writable_file_descriptor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = os.fsync
    synced_files = []

    def windows_compatible_fsync(fd: int) -> None:
        if stat.S_ISREG(os.fstat(fd).st_mode):
            # A zero-byte write changes nothing but rejects a read-only descriptor,
            # matching the Windows CRT requirement for fsync/_commit.
            assert os.write(fd, b"") == 0
            synced_files.append(fd)
        original(fd)

    monkeypatch.setattr(os, "fsync", windows_compatible_fsync)
    result = write_workbook([], tmp_path / "snapshot.xlsx")
    assert result["order_count"] == 0
    assert synced_files
