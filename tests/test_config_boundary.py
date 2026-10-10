"""Legacy capture configuration must not activate implicit input collection."""

from pathlib import Path

import pytest

from ocrs.config import Settings


def test_legacy_inbox_environment_is_ignored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OCRS_DATA_DIR", str(tmp_path / "synthetic-data"))
    monkeypatch.setenv("OCRS_ACCESS_TOKEN", "synthetic-boundary-token-" * 2)
    monkeypatch.setenv("OCRS_INBOX", str(tmp_path / "must-not-be-scanned"))
    settings = Settings.from_env()
    assert settings.inbox is None
    assert settings.data_dir == (tmp_path / "synthetic-data").resolve()
    assert not settings.data_dir.exists()
