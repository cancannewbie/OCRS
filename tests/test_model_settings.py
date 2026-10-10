"""Only fictitious keys; storage tests never make provider requests."""

import json
import multiprocessing
import os
import sqlite3
from pathlib import Path

import pytest
from pydantic import ValidationError

from ocrs.model_settings import (
    ModelSettingsConflict,
    ModelSettingsError,
    ModelSettingsStore,
    ModelSettingsUpdate,
)
from ocrs.storage import backup, migrate

FAKE_KEY = "fictitious-test-key-never-a-real-credential"


def update(revision: int = 0, **values: object) -> ModelSettingsUpdate:
    payload: dict[str, object] = {
        "expected_revision": revision,
        "provider": "openai-compatible",
        "model": "fictional-model",
        "base_url": "https://api.example.com/v1",
        "api_key_action": "replace",
        "api_key": FAKE_KEY,
    }
    payload.update(values)
    return ModelSettingsUpdate.model_validate(payload)


@pytest.fixture
def store(tmp_path: Path) -> ModelSettingsStore:
    return ModelSettingsStore(tmp_path / "business", key_dir=tmp_path / "private")


def test_default_is_demo_ignores_environment(store: ModelSettingsStore, monkeypatch) -> None:
    monkeypatch.setenv("OCRS_PROVIDER", "minimax-cn")
    monkeypatch.setenv("OCRS_API_KEY", FAKE_KEY)
    snapshot = store.snapshot()
    assert snapshot.revision == 0 and snapshot.provider == "demo"
    assert not snapshot.api_key and not snapshot.allow_external
    assert not store.key_path.exists()


def test_persistence_encryption_separation_and_permissions(store: ModelSettingsStore) -> None:
    request = update()
    snapshot = store.save(request)
    assert snapshot.api_key == FAKE_KEY and snapshot.revision == 1
    assert snapshot.public()["status"] == "configured"
    assert snapshot.public()["test_status"] == "not_tested"
    assert FAKE_KEY not in repr(snapshot)
    assert FAKE_KEY not in repr(request)
    assert FAKE_KEY not in json.dumps(snapshot.public())
    assert FAKE_KEY not in json.dumps(request.model_dump())
    assert FAKE_KEY.encode() not in store.path.read_bytes()
    assert store.data_dir not in store.key_path.parents
    reopened = ModelSettingsStore(store.data_dir, key_dir=store.key_dir)
    assert reopened.snapshot() == snapshot
    if os.name != "nt":
        assert store.key_dir.stat().st_mode & 0o777 == 0o700
        assert store.key_path.stat().st_mode & 0o777 == 0o600
        assert store.path.stat().st_mode & 0o777 == 0o600


def test_keep_delete_replace_and_demo(store: ModelSettingsStore) -> None:
    store.save(update())
    kept = store.save(update(1, api_key_action="keep", api_key=""))
    assert kept.api_key == FAKE_KEY
    deleted = store.save(update(2, api_key_action="delete", api_key=None))
    assert not deleted.api_key and deleted.public()["status"] == "not_configured"
    store.save(update(3))
    demo = store.save(update(4, provider="demo", api_key_action="keep", api_key=None))
    assert not demo.api_key and not demo.allow_external


def test_destination_change_cannot_reuse_key(store: ModelSettingsStore) -> None:
    store.save(update())
    with pytest.raises(ModelSettingsError, match="替换或删除"):
        store.save(
            update(1, base_url="https://another.example.com", api_key_action="keep", api_key=None)
        )
    assert store.snapshot().revision == 1
    snapshot = store.save(
        update(1, base_url="https://another.example.com", api_key_action="delete", api_key=None)
    )
    assert not snapshot.api_key


def test_revision_and_test_result_lifecycle(store: ModelSettingsStore) -> None:
    store.save(update())
    assert store.record_test(1, True).test_status == "passed"
    assert store.record_test(1, False).test_status == "failed"
    with pytest.raises(ModelSettingsConflict):
        store.save(update())
    snapshot = store.save(update(1))
    assert snapshot.test_status == "not_tested"
    with pytest.raises(ModelSettingsConflict):
        store.record_test(1, True)
    assert store.snapshot().test_status == "not_tested"


def _race_save(root: str, key_dir: str, results) -> None:
    store = ModelSettingsStore(Path(root), key_dir=Path(key_dir))
    try:
        store.save(update())
        results.put("saved")
    except ModelSettingsConflict:
        results.put("conflict")


def test_cross_process_optimistic_lock(store: ModelSettingsStore) -> None:
    context = multiprocessing.get_context("spawn")
    results = context.Queue()
    processes = [
        context.Process(target=_race_save, args=(str(store.data_dir), str(store.key_dir), results))
        for _ in range(2)
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=20)
        assert process.exitcode == 0
    assert sorted(results.get(timeout=3) for _ in processes) == ["conflict", "saved"]
    assert store.snapshot().revision == 1


@pytest.mark.parametrize(
    "url",
    [
        "http://api.example.com",
        "https://localhost",
        "https://127.0.0.1/v1",
        "https://10.0.0.1",
        "https://169.254.169.254",
        "https://[::1]",
        "https://[fc00::1]",
        "https://name:secret@api.example.com",
        "https://api.example.com?secret=x",
        "https://api.example.com#fragment",
        "https://metadata.google.internal",
        "https://api.local",
        "https://2130706433",
        "https://api.example.com:8443",
        "https://api.example.com\n",
        "https://127.1",
    ],
)
def test_invalid_destinations_rejected_without_network(url: str) -> None:
    with pytest.raises(ValidationError):
        update(base_url=url)


@pytest.mark.parametrize(
    "fields",
    [
        {"model": "m" * 201},
        {"api_key": "x\ny"},
        {"api_key": "x" * 8193},
        {"api_key": "密钥"},
        {"api_key_action": "replace", "api_key": ""},
        {"timeout_seconds": 61},
        {"total_timeout_seconds": 181},
        {"max_output_tokens": 8193},
        {"max_requests": 100001},
        {"max_requests": True},
        {"timeout_seconds": 40, "total_timeout_seconds": 30},
        {"provider": "minimax-cn", "model": "wrong"},
    ],
)
def test_invalid_fields_do_not_expose_key(fields: dict[str, object]) -> None:
    with pytest.raises(ValidationError) as error:
        update(**fields)
    assert FAKE_KEY not in str(error.value)


def test_minimax_fixed_configuration(store: ModelSettingsStore) -> None:
    result = store.save(
        update(provider="minimax-cn", model="MiniMax-M3", base_url="https://api.minimax.cn/v1")
    )
    assert result.model == "MiniMax-M3"


def test_missing_or_corrupt_key_fails_closed(store: ModelSettingsStore) -> None:
    store.save(update())
    store.key_path.unlink()
    with pytest.raises(ModelSettingsError):
        store.snapshot()
    assert not store.key_path.exists()
    # An explicit replacement recovers without resurrecting the old secret.
    assert store.save(update(1)).api_key == FAKE_KEY
    with sqlite3.connect(store.path) as connection:
        connection.execute("UPDATE model_settings SET secret=?", (b"corrupt",))
    with pytest.raises(ModelSettingsError) as error:
        store.snapshot()
    assert FAKE_KEY not in str(error.value)
    assert not store.save(update(2, api_key_action="delete", api_key=None)).api_key


def test_business_backup_excludes_settings_and_key(
    store: ModelSettingsStore, tmp_path: Path
) -> None:
    migrate(store.data_dir)
    store.save(update())
    destination = tmp_path / "backup"
    backup(store.data_dir, destination)
    assert not (destination / "model-settings.sqlite3").exists()
    assert not list(destination.rglob("*.key"))
    assert FAKE_KEY.encode() not in (destination / "ocrs.sqlite3").read_bytes()
    restored = ModelSettingsStore(destination, key_dir=store.key_dir)
    assert restored.snapshot().provider == "demo"


def test_key_directory_inside_business_root_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ModelSettingsError):
        ModelSettingsStore(tmp_path, key_dir=tmp_path / "keys")


def test_replacing_key_changes_ciphertext(store: ModelSettingsStore) -> None:
    store.save(update())
    with sqlite3.connect(store.path) as connection:
        first = connection.execute("SELECT secret FROM model_settings").fetchone()[0]
    store.save(update(1))
    with sqlite3.connect(store.path) as connection:
        second = connection.execute("SELECT secret FROM model_settings").fetchone()[0]
    assert first != second


def test_failed_keep_does_not_commit_with_lost_key(store: ModelSettingsStore) -> None:
    store.save(update())
    store.key_path.unlink()
    with pytest.raises(ModelSettingsError):
        store.save(update(1, api_key_action="keep", api_key=None))
    with sqlite3.connect(store.path) as connection:
        assert connection.execute("SELECT revision FROM model_settings").fetchone()[0] == 1


def test_application_keys_are_isolated_by_root(store: ModelSettingsStore, tmp_path: Path) -> None:
    store.save(update())
    other = ModelSettingsStore(tmp_path / "second-business", key_dir=store.key_dir)
    other.save(update())
    assert other.key_path != store.key_path
    assert other.key_path.read_bytes() != store.key_path.read_bytes()


def test_snapshot_is_immutable(store: ModelSettingsStore) -> None:
    from dataclasses import FrozenInstanceError

    snapshot = store.snapshot()
    with pytest.raises(FrozenInstanceError):
        snapshot.provider = "other"  # type: ignore[misc]


@pytest.mark.parametrize("damage", ["missing_key", "corrupt_key", "corrupt_ciphertext"])
def test_public_metadata_allows_credential_recovery(store: ModelSettingsStore, damage: str) -> None:
    store.save(update())
    store.record_test(1, True)
    if damage == "missing_key":
        store.key_path.unlink()
    elif damage == "corrupt_key":
        store.key_path.write_bytes(b"not-a-valid-master-key")
    else:
        with sqlite3.connect(store.path) as connection:
            connection.execute("UPDATE model_settings SET secret=?", (b"invalid-ciphertext",))
    with pytest.raises(ModelSettingsError):
        store.snapshot()
    public = store.public()
    assert public["revision"] == 1
    assert public["provider"] == "openai-compatible"
    assert public["model"] == "fictional-model"
    assert public["base_url"] == "https://api.example.com/v1"
    assert public["api_key_configured"] is True
    assert public["credential_status"] == "unavailable"
    assert public["status"] == "not_configured"
    assert public["test_status"] == "not_tested"
    assert FAKE_KEY not in json.dumps(public)
    recovered = store.save(update(public["revision"], api_key_action="delete", api_key=None))
    assert recovered.revision == 2
    assert store.public()["credential_status"] == "missing"
    assert not store.snapshot().api_key


def test_public_metadata_missing_key_replace_recovers(store: ModelSettingsStore) -> None:
    store.save(update())
    store.key_path.unlink()
    public = store.public()
    recovered = store.save(update(public["revision"]))
    assert recovered.api_key == FAKE_KEY
    assert store.public()["credential_status"] == "available"


def test_public_corrupt_metadata_still_fails_closed(store: ModelSettingsStore) -> None:
    store.save(update())
    store.key_path.unlink()
    with sqlite3.connect(store.path) as connection:
        connection.execute("UPDATE model_settings SET config=?", ('{"provider":"unknown"}',))
    with pytest.raises(ModelSettingsError):
        store.public()


def test_explicit_replace_recovers_corrupt_master_key(store: ModelSettingsStore) -> None:
    store.save(update())
    store.key_path.write_bytes(b"corrupted-key")
    assert store.public()["credential_status"] == "unavailable"
    assert store.save(update(1)).api_key == FAKE_KEY
    assert store.snapshot().api_key == FAKE_KEY
    assert store.public()["credential_status"] == "available"
    assert not list(store.key_dir.glob(".key-*"))


def test_whitespace_only_model_is_not_configured(store: ModelSettingsStore) -> None:
    snapshot = store.save(update(model="   "))
    assert snapshot.model == ""
    assert snapshot.public()["status"] == "not_configured"
    assert store.public()["status"] == "not_configured"


@pytest.mark.parametrize(
    "host",
    [
        "168.63.129.16",
        "224.0.0.1",
        "[ff02::1]",
        "[2002:0808:0808::1]",
        "[::ffff:8.8.8.8]",
        "[2001::1]",
    ],
)
def test_save_uses_transport_public_ip_rules(host: str) -> None:
    with pytest.raises(ValidationError):
        update(base_url=f"https://{host}/v1")
