"""Offline MiniMax CN contracts; all images, identities and credentials are fictional."""

from __future__ import annotations

import base64
import io
import json
import os
from collections.abc import Callable
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest
from PIL import Image

from ocrs.config import Settings
from ocrs.domain import Candidate
from ocrs.providers import MiniMaxCNProvider, ProviderError, RecognitionSource
from ocrs.service import Service
from ocrs.storage import connect, migrate

FAKE_KEY = "fictional-minimax-key-for-offline-tests"
CN_URL = "https://api.minimax.cn/v1"


@pytest.fixture(autouse=True)
def forbid_live_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail(*args: Any, **kwargs: Any) -> httpx.Response:
        pytest.fail("MiniMax contract tests must never make live HTTP requests")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fail)


def synthetic_image() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (12, 12), "white").save(output, format="PNG")
    return output.getvalue()


@pytest.fixture
def source(tmp_path: Path) -> RecognitionSource:
    path = tmp_path / "fictional-minimax.png"
    path.write_bytes(synthetic_image())
    return RecognitionSource("fictional-source-1", path, "image/png")


def candidate_payload(source_id: str = "fictional-source-1") -> dict[str, Any]:
    return {
        "schema_version": "1",
        "events": [
            {
                "action": "create",
                "customer": "Fictional MiniMax test buyer",
                "external_id": "00019",
                "currency": "CNY",
                "occurred_at": None,
                "items": [
                    {
                        "sku": "DEMO-001",
                        "name": "Imaginary test product",
                        "quantity": "0.1",
                        "unit": "piece",
                        "unit_price": "0.20",
                    }
                ],
                "evidence": [{"source_id": source_id, "field": "items.0", "text": "fake"}],
                "missing_reasons": ["occurred_at: not shown in fictional image"],
            }
        ],
    }


def envelope(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "base_resp": {"status_code": 0, "status_msg": "success"},
        "input_sensitive": False,
        "output_sensitive": False,
        "choices": [
            {
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": json.dumps(candidate_payload() if payload is None else payload),
                },
            }
        ],
    }


def backend(handler: Callable[[httpx.Request], httpx.Response], **kwargs: Any) -> MiniMaxCNProvider:
    options: dict[str, Any] = {
        "base_url": CN_URL,
        "model": "MiniMax-M3",
        "api_key": FAKE_KEY,
        "transport": httpx.MockTransport(handler),
        "min_request_interval": 0,
    }
    options.update(kwargs)
    return MiniMaxCNProvider(**options)


def test_minimax_request_uses_cn_vision_dialect_and_full_local_schema(
    source: RecognitionSource,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=envelope())

    provider = backend(handler, max_output_tokens=2048)
    result = provider.recognize([source])
    assert provider.name == "minimax-cn"
    assert len(requests) == 1
    request = requests[0]
    assert request.method == "POST"
    assert str(request.url) == CN_URL + "/chat/completions"
    assert request.headers["authorization"] == "Bearer " + FAKE_KEY
    assert FAKE_KEY.encode() not in request.content
    assert str(source.path).encode() not in request.content
    payload = json.loads(request.content)
    assert set(payload) == {
        "model",
        "messages",
        "max_completion_tokens",
        "reasoning_split",
        "thinking",
        "temperature",
        "stream",
    }
    assert payload["model"] == "MiniMax-M3"
    assert payload["max_completion_tokens"] == 2048
    assert payload["reasoning_split"] is True
    assert payload["thinking"] == {"type": "disabled"}
    assert payload["temperature"] == 0
    assert payload["stream"] is False
    assert payload["messages"][0]["role"] == "system"
    prompt = payload["messages"][0]["content"]
    assert "untrusted evidence" in prompt
    assert "human review" in prompt
    schema = json.loads(prompt[prompt.index("{") :])
    local_schema = Candidate.model_json_schema()
    assert schema["properties"].keys() == local_schema["properties"].keys()
    assert schema["$defs"].keys() == local_schema["$defs"].keys()
    for name, definition in local_schema["$defs"].items():
        assert schema["$defs"][name]["properties"].keys() == definition["properties"].keys()
        assert schema["$defs"][name]["additionalProperties"] is False
        assert set(schema["$defs"][name]["required"]) == set(definition["properties"])
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(local_schema["properties"])
    content = payload["messages"][1]["content"]
    assert content[0] == {"type": "text", "text": "Source ID: fictional-source-1"}
    assert content[1] == {
        "type": "image_url",
        "image_url": {
            "url": "data:image/png;base64," + base64.b64encode(source.path.read_bytes()).decode(),
            "detail": "default",
        },
    }
    assert result.events[0].external_id == "00019"
    assert result.events[0].items[0].quantity == Decimal("0.1")
    assert result.events[0].items[0].unit_price == Decimal("0.20")
    assert result.events[0].occurred_at is None


def test_minimax_accepts_documented_trailing_slash(source: RecognitionSource) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=envelope())

    backend(handler, base_url=CN_URL + "/").recognize([source])
    assert str(requests[0].url) == CN_URL + "/chat/completions"


@pytest.mark.parametrize(
    "base_url",
    [
        "https://api.minimax.io/v1",
        "https://api.minimax.chat/v1",
        "https://api.openai.com/v1",
        "http://api.minimax.cn/v1",
        "http://localhost/v1",
        "https://api.minimax.cn/v1?token=fictional",
        "https://api.minimax.cn/v1#fragment",
        "https://fictional:credential@api.minimax.cn/v1",
        "https://api.minimax.cn/v1/chat/completions",
        "https://api.minimax.cn.example.invalid/v1",
        "https://api.minimax.cn:443/v1",
        " https://api.minimax.cn/v1",
    ],
)
def test_minimax_rejects_unapproved_destinations(base_url: str) -> None:
    with pytest.raises(ProviderError, match="^provider_config_base_url$"):
        backend(lambda _: pytest.fail("configuration must not send"), base_url=base_url)


@pytest.mark.parametrize("model", ["", "MiniMax-M2.7", "MiniMax-M3.1", "minimax-m3", "other"])
def test_minimax_rejects_models_without_verified_vision_contract(model: str) -> None:
    with pytest.raises(ProviderError, match="^provider_config_model$"):
        backend(lambda _: pytest.fail("configuration must not send"), model=model)


def bad_envelope(case: str) -> tuple[dict[str, Any], str]:
    response = envelope()
    choice = response["choices"][0]
    message = choice["message"]
    code = "provider_schema_invalid"
    if case == "api_error":
        response["base_resp"] = {"status_code": 1008, "status_msg": "FICTIONAL-PRIVATE-TEXT"}
        code = "provider_api_rejected"
    elif case in {"input_sensitive", "output_sensitive"}:
        response[case] = True
        code = "provider_refused"
    elif case == "refusal":
        message["refusal"] = "FICTIONAL-PRIVATE-TEXT"
        code = "provider_refused"
    elif case == "truncated":
        choice["finish_reason"] = "length"
        code = "provider_truncated"
    elif case == "non_json":
        message["content"] = "FICTIONAL-PRIVATE-TEXT"
    elif case == "markdown":
        message["content"] = "```json\n" + message["content"] + "\n```"
    elif case == "wrong_schema":
        message["content"] = json.dumps({"schema_version": "2", "events": []})
    elif case == "tool_call":
        message["tool_calls"] = [{"name": "fictional_forbidden_tool"}]
        code = "provider_tool_call_rejected"
    elif case == "wrong_evidence":
        message["content"] = json.dumps(candidate_payload("not-a-supplied-source"))
        code = "provider_evidence_invalid"
    elif case == "float_quantity":
        payload = candidate_payload()
        payload["events"][0]["items"][0]["quantity"] = 0.1
        message["content"] = json.dumps(payload)
    elif case == "unknown_field":
        payload = candidate_payload()
        payload["confirmed"] = True
        message["content"] = json.dumps(payload)
    elif case == "duplicate_json_key":
        message["content"] = '{"schema_version":"1","schema_version":"1","events":[]}'
    elif case == "malformed_status":
        response["base_resp"] = {"status_code": "0"}
    elif case == "boolean_status":
        response["base_resp"] = {"status_code": False}
    else:
        raise AssertionError("unknown fabricated failure case")
    return response, code


FAILURE_CASES = [
    "api_error",
    "input_sensitive",
    "output_sensitive",
    "refusal",
    "truncated",
    "non_json",
    "markdown",
    "wrong_schema",
    "tool_call",
    "wrong_evidence",
    "float_quantity",
    "unknown_field",
    "duplicate_json_key",
    "malformed_status",
    "boolean_status",
]


@pytest.mark.parametrize("case", FAILURE_CASES)
def test_minimax_rejects_unsafe_output_once_without_leaking_body(
    source: RecognitionSource, case: str, caplog: pytest.LogCaptureFixture
) -> None:
    body, code = bad_envelope(case)
    provider = backend(lambda _: httpx.Response(200, json=body))
    with pytest.raises(ProviderError) as error:
        provider.recognize([source])
    assert error.value.code == code
    assert provider.requests_used == 1
    assert "FICTIONAL-PRIVATE-TEXT" not in str(error.value) + caplog.text
    assert FAKE_KEY not in str(error.value) + caplog.text


def test_minimax_ignores_separate_reasoning_and_preserves_uncertainty(
    source: RecognitionSource,
) -> None:
    payload = candidate_payload()
    payload["events"].append(
        {
            "action": "cancel",
            "target_order_id": None,
            "missing_reasons": ["target_order_id: unknown"],
        }
    )
    body = envelope(payload)
    body["choices"][0]["message"]["reasoning_content"] = "FICTIONAL-PRIVATE-REASONING"
    result = backend(lambda _: httpx.Response(200, json=body)).recognize([source])
    assert len(result.events) == 2
    assert result.events[1].target_order_id is None
    assert "FICTIONAL-PRIVATE-REASONING" not in result.model_dump_json()


def test_minimax_keeps_bounded_retry_and_request_budget(
    source: RecognitionSource, monkeypatch: pytest.MonkeyPatch
) -> None:
    delays: list[float] = []
    monkeypatch.setattr("ocrs.providers.time.sleep", delays.append)
    calls = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(429, headers={"Retry-After": "2"})
        return httpx.Response(200, json=envelope())

    provider = backend(handler, max_requests=2)
    provider.recognize([source])
    assert calls == provider.requests_used == 2
    assert delays == [2]
    with pytest.raises(ProviderError, match="^provider_request_budget$"):
        provider.recognize([source])
    assert calls == 2


def test_minimax_does_not_follow_redirects(source: RecognitionSource) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(307, headers={"Location": "https://example.invalid/collect"})

    with pytest.raises(ProviderError, match="^provider_http_rejected$"):
        backend(handler).recognize([source])
    assert len(requests) == 1
    assert requests[0].url.host == "api.minimax.cn"


@pytest.mark.parametrize(
    "options,code",
    [
        ({"max_input_bytes": 1}, "provider_input_budget"),
        ({"max_response_bytes": 1}, "provider_response_limit"),
    ],
)
def test_minimax_preserves_input_and_output_limits(
    source: RecognitionSource, options: dict[str, int], code: str
) -> None:
    provider = backend(lambda _: httpx.Response(200, json=envelope()), **options)
    with pytest.raises(ProviderError, match=f"^{code}$"):
        provider.recognize([source])


def minimax_service(tmp_path: Path) -> Service:
    migrate(tmp_path)
    return Service(
        Settings(
            data_dir=tmp_path,
            token="fictional-minimax-local-token-" * 2,
            provider="minimax-cn",
            model_url=CN_URL,
            model="MiniMax-M3",
            api_key=FAKE_KEY,
            allow_external=True,
        )
    )


@pytest.mark.parametrize("case", FAILURE_CASES)
def test_minimax_failures_never_persist_candidates_or_formal_orders(
    tmp_path: Path, case: str, caplog: pytest.LogCaptureFixture
) -> None:
    service = minimax_service(tmp_path)
    body, code = bad_envelope(case)
    service.provider = backend(lambda _: httpx.Response(200, json=body))
    task, _ = service.ingest(
        synthetic_image(),
        "fictional.png",
        "fictional-minimax-source",
        config_revision=0,
        confirm_external=True,
    )
    assert service.process_one()
    failed = service.task(task["id"])
    assert failed["status"] == "failed"
    assert failed["error_code"] == code
    assert failed["candidate"] is None
    assert failed["attempts"] == 1
    assert not service.process_one()
    assert service.orders() == []
    with connect(tmp_path) as db:
        for table in ("candidate_history", "orders", "items", "events", "outbox"):
            assert db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0
    assert service.export()["order_count"] == 0
    assert "FICTIONAL-PRIVATE-TEXT" not in json.dumps(failed) + caplog.text
    assert FAKE_KEY not in json.dumps(failed) + caplog.text


def test_minimax_success_remains_unconfirmed_and_records_provider_metadata(tmp_path: Path) -> None:
    service = minimax_service(tmp_path)
    assert isinstance(service.provider, MiniMaxCNProvider)

    def handler(request: httpx.Request) -> httpx.Response:
        content = json.loads(request.content)["messages"][1]["content"]
        source_id = content[0]["text"].removeprefix("Source ID: ")
        return httpx.Response(200, json=envelope(candidate_payload(source_id)))

    service.provider = backend(handler)
    task, _ = service.ingest(
        synthetic_image(),
        "fictional.png",
        "fictional-minimax-source",
        config_revision=0,
        confirm_external=True,
    )
    assert service.process_one()
    reviewed = service.task(task["id"])
    assert reviewed["status"] == "review_required"
    assert reviewed["provider"] == "minimax-cn"
    assert reviewed["candidate"]["events"][0]["items"][0]["quantity"] == "0.1"
    assert reviewed["error_code"] is None
    assert service.orders() == []
    assert service.export()["order_count"] == 0
    with connect(tmp_path) as db:
        history = db.execute("SELECT * FROM candidate_history").fetchall()
        assert len(history) == 1
        assert history[0]["model"] == "MiniMax-M3"
        assert history[0]["prompt_version"] == service.provider.prompt_version
        for table in ("orders", "items", "events", "outbox"):
            assert db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0


@pytest.fixture
def minimax_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Ignore developer-machine settings: these are offline, synthetic contracts.
    for name in tuple(os.environ):
        if name.startswith("OCRS_"):
            monkeypatch.delenv(name)
    for name, value in {
        "OCRS_DATA_DIR": str(tmp_path),
        "OCRS_ACCESS_TOKEN": "fictional-local-access-token-" * 2,
        "OCRS_PROVIDER": "minimax-cn",
        "OCRS_MODEL": "MiniMax-M3",
        "OCRS_API_KEY": FAKE_KEY,
        "OCRS_ALLOW_EXTERNAL": "true",
    }.items():
        monkeypatch.setenv(name, value)


@pytest.mark.usefixtures("minimax_env")
def test_legacy_minimax_env_does_not_override_page_settings() -> None:
    settings = Settings.from_env()
    assert settings.provider == "demo"
    assert settings.model == ""
    assert settings.api_key == ""
    assert settings.allow_external is False
    assert FAKE_KEY not in repr(settings)


@pytest.mark.usefixtures("minimax_env")
@pytest.mark.parametrize("provider", ["demo", "openai-compatible"])
def test_other_providers_keep_original_endpoint_and_timeout_defaults(
    provider: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OCRS_PROVIDER", provider)
    settings = Settings.from_env()
    assert settings.model_url == "https://api.openai.com/v1"
    assert settings.model_timeout_seconds == 15
    assert settings.model_total_timeout_seconds == 45


@pytest.mark.usefixtures("minimax_env")
@pytest.mark.parametrize("missing", ["OCRS_API_KEY", "OCRS_MODEL", "OCRS_ALLOW_EXTERNAL"])
def test_missing_legacy_model_variables_does_not_block_local_login(
    missing: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(missing)
    assert Settings.from_env().provider == "demo"


@pytest.mark.usefixtures("minimax_env")
def test_legacy_model_limit_overrides_are_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in {
        "OCRS_MODEL_TIMEOUT_SECONDS": "20",
        "OCRS_MODEL_TOTAL_TIMEOUT_SECONDS": "40",
        "OCRS_MODEL_MAX_OUTPUT_TOKENS": "1024",
        "OCRS_MAX_REQUESTS": "2",
    }.items():
        monkeypatch.setenv(name, value)
    settings = Settings.from_env()
    assert settings.model_timeout_seconds == 15
    assert settings.model_total_timeout_seconds == 45
    assert settings.model_max_output_tokens == 4096
    assert settings.max_requests == 100


@pytest.mark.usefixtures("minimax_env")
@pytest.mark.parametrize(
    "name,value",
    [
        ("OCRS_MODEL_TIMEOUT_SECONDS", "0"),
        ("OCRS_MODEL_TIMEOUT_SECONDS", "61"),
        ("OCRS_MODEL_TOTAL_TIMEOUT_SECONDS", "0"),
        ("OCRS_MODEL_TOTAL_TIMEOUT_SECONDS", "181"),
        ("OCRS_MODEL_TOTAL_TIMEOUT_SECONDS", "59"),
        ("OCRS_MODEL_MAX_OUTPUT_TOKENS", "0"),
        ("OCRS_MODEL_MAX_OUTPUT_TOKENS", "8193"),
        ("OCRS_MAX_REQUESTS", "0"),
        ("OCRS_MAX_REQUESTS", "100001"),
        ("OCRS_MODEL_TIMEOUT_SECONDS", "nan"),
        ("OCRS_MODEL_TOTAL_TIMEOUT_SECONDS", "1.5"),
        ("OCRS_MODEL_MAX_OUTPUT_TOKENS", "true"),
        ("OCRS_MAX_REQUESTS", "fictional-invalid-value"),
    ],
)
def test_legacy_invalid_limits_do_not_prevent_page_configuration(
    name: str, value: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(name, value)
    settings = Settings.from_env()
    assert settings.provider == "demo"
    assert FAKE_KEY not in repr(settings)
