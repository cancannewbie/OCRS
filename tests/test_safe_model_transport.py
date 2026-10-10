"""No real DNS, sockets, API credentials or customer data in these regressions."""

from __future__ import annotations

import base64
import io
import json
import socket
import ssl
import threading
from typing import Any

import httpcore
import httpx
import pytest
from PIL import Image

from ocrs.providers import OpenAICompatibleProvider, ProviderError
from ocrs.safe_transport import PublicHTTPTransport, PublicNetworkBackend


def model(**kwargs: Any) -> OpenAICompatibleProvider:
    return OpenAICompatibleProvider(
        base_url=kwargs.pop("base_url", "https://vision.example/v1"),
        model="fictional-vision",
        api_key="fake-test-key",
        max_attempts=1,
        min_request_interval=0,
        **kwargs,
    )


def address(ip: str) -> tuple[Any, ...]:
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    endpoint = (ip, 443, 0, 0) if family == socket.AF_INET6 else (ip, 443)
    return family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", endpoint


@pytest.mark.parametrize(
    "host",
    [
        "127.0.0.1",
        "localhost",
        "service.localhost",
        "10.0.0.1",
        "169.254.169.254",
        "168.63.129.16",
        "192.168.1.2",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "[::1]",
        "[fc00::1]",
        "[fe80::1]",
        "[::ffff:127.0.0.1]",
        "[2002:7f00:1::]",
        "metadata.google.internal",
    ],
)
def test_private_literal_configuration_rejected_without_network(
    host: str, monkeypatch: Any
) -> None:
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: pytest.fail("DNS during save"))
    with pytest.raises(ProviderError, match="provider_config_base_url"):
        model(base_url=f"https://{host}/v1")


def test_public_constructor_does_not_resolve(monkeypatch: Any) -> None:
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: pytest.fail("DNS during save"))
    model()


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.4", "169.254.169.254", "::1", "fc00::2"])
def test_private_or_mixed_dns_answers_rejected(ip: str, monkeypatch: Any) -> None:
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [address("8.8.8.8"), address(ip)])
    monkeypatch.setattr(socket, "socket", lambda *a, **k: pytest.fail("socket before validation"))
    with pytest.raises(httpcore.ConnectError, match="unsafe_model_destination"):
        PublicNetworkBackend().connect_tcp("vision.example", 443, timeout=1)


class FakeSocket:
    def __init__(self, response: bytes = b"") -> None:
        self.connected: list[Any] = []
        self.written = bytearray()
        self.response = response
        self.closed = False

    def settimeout(self, timeout: Any) -> None:
        pass

    def setsockopt(self, *args: Any) -> None:
        pass

    def connect(self, endpoint: Any) -> None:
        self.connected.append(endpoint)

    def send(self, data: bytes) -> int:
        self.written.extend(data)
        return len(data)

    def recv(self, size: int) -> bytes:
        result, self.response = self.response[:size], self.response[size:]
        return result

    def close(self) -> None:
        self.closed = True

    def fileno(self) -> int:
        return -1

    def getpeername(self) -> Any:
        return self.connected[0]

    def getsockname(self) -> Any:
        return ("0.0.0.0", 0)


def test_dns_rebinding_is_pinned_and_tls_uses_original_host(monkeypatch: Any) -> None:
    lookups: list[str] = []

    def lookup(host: str, *args: Any, **kwargs: Any) -> list[Any]:
        lookups.append(host)
        return [address("8.8.8.8" if len(lookups) == 1 else "127.0.0.1")]

    sock = FakeSocket(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
    monkeypatch.setattr(socket, "getaddrinfo", lookup)
    monkeypatch.setattr(socket, "socket", lambda *a, **k: sock)
    tls_names: list[str] = []

    def wrap(context: ssl.SSLContext, connection: Any, *, server_hostname: str) -> Any:
        assert context.check_hostname is True
        assert context.verify_mode == ssl.CERT_REQUIRED
        tls_names.append(server_hostname)
        return connection

    monkeypatch.setattr(ssl.SSLContext, "wrap_socket", wrap)
    with httpx.Client(transport=PublicHTTPTransport(), trust_env=False) as client:
        assert client.get("https://vision.example/v1").status_code == 200
    assert lookups == ["vision.example"]
    assert sock.connected == [("8.8.8.8", 443)]
    assert tls_names == ["vision.example"]
    assert b"Host: vision.example" in sock.written
    assert sock.closed


def test_dns_timeout_is_bounded(monkeypatch: Any) -> None:
    release = threading.Event()

    def lookup(*args: Any, **kwargs: Any) -> list[Any]:
        release.wait(2)
        return [address("8.8.8.8")]

    monkeypatch.setattr(socket, "getaddrinfo", lookup)
    try:
        with pytest.raises(httpcore.ConnectTimeout):
            PublicNetworkBackend().connect_tcp("vision.example", 443, timeout=0.01)
    finally:
        release.set()


def test_socket_timeout_is_mapped_and_closed(monkeypatch: Any) -> None:
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [address("8.8.8.8")])
    sock = FakeSocket()

    def timeout(endpoint: Any) -> None:
        raise TimeoutError("private diagnostic")

    monkeypatch.setattr(sock, "connect", timeout)
    monkeypatch.setattr(socket, "socket", lambda *a, **k: sock)
    with pytest.raises(httpcore.ConnectTimeout, match="model_connect_timeout"):
        PublicNetworkBackend().connect_tcp("vision.example", 443, timeout=1)
    assert sock.closed


def test_probe_is_explicit_synthetic_and_discards_content() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        payload = json.loads(request.content)
        content = payload["messages"][1]["content"]
        assert content[0]["text"] == "Source ID: synthetic-connection-test"
        data = base64.b64decode(content[1]["image_url"]["url"].split(",")[1])
        image = Image.open(io.BytesIO(data))
        assert image.size == (320, 96)
        assert image.getpixel((0, 0)) == (255, 255, 255)
        assert payload["response_format"]["json_schema"]["name"] == "ocrs_candidate_v1"
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": json.dumps(
                                {
                                    "schema_version": "1",
                                    "events": [{"action": "create"}],
                                    "warnings": [],
                                }
                            )
                        },
                    }
                ]
            },
        )

    provider = model(transport=httpx.MockTransport(handler))
    assert not requests
    assert provider.test_connection() is None
    assert len(requests) == 1


def test_probe_redirect_does_not_send_credentials_to_target() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(307, headers={"Location": "https://127.0.0.1/admin"})

    with pytest.raises(ProviderError, match="provider_http_rejected"):
        model(transport=httpx.MockTransport(handler)).test_connection()
    assert len(requests) == 1
    assert requests[0].url.host == "vision.example"


def test_probe_schema_failure_is_not_connection_success() -> None:
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"secret": "ignored"}))
    with pytest.raises(ProviderError, match="provider_schema_invalid"):
        model(transport=transport).test_connection()


def test_ambient_certificate_and_proxy_settings_are_ignored(monkeypatch: Any) -> None:
    monkeypatch.setenv("SSL_CERT_FILE", "/does-not-exist/unsafe-ca.pem")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:8123")
    with PublicHTTPTransport():
        pass
