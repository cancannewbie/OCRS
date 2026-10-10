"""Public-only, DNS-pinned model HTTPS connections.

The HTTP origin is never rewritten: httpcore supplies its original hostname to
TLS verification/SNI and HTTP Host. Only the raw TCP socket uses a resolved IP.
"""

from __future__ import annotations

import ipaddress
import queue
import socket
import threading
import time
from collections.abc import Iterable
from typing import Any

import httpcore
import httpx
from httpcore._backends.sync import SyncBackend, SyncStream

_RESOLVER_SLOTS = threading.BoundedSemaphore(4)


def _public_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return (
        address.is_global
        and str(address) != "168.63.129.16"  # Azure platform/metadata virtual IP.
        and not address.is_multicast
        and not address.is_reserved
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_unspecified
        and not (
            isinstance(address, ipaddress.IPv6Address)
            and (address.ipv4_mapped or address.sixtofour or address.teredo)
        )
    )


def validate_public_host(host: str) -> None:
    """Reject clearly unsafe hosts without any DNS or other network activity."""
    normalized = host.lower().rstrip(".")
    if (
        not normalized
        or any(char in host for char in "%\\\x00\r\n\t")
        or normalized == "localhost"
        or normalized.endswith(".localhost")
        or normalized == "metadata.google.internal"
    ):
        raise ValueError("unsafe_model_destination")
    try:
        ipaddress.ip_address(normalized)
    except ValueError:
        return
    if not _public_ip(normalized):
        raise ValueError("unsafe_model_destination")


def _resolve(host: str, port: int, timeout: float) -> list[Any]:
    # libc DNS has no portable cancellation. Bound both caller latency and the
    # number of outstanding daemon workers, including after callers time out.
    started = time.monotonic()
    if not _RESOLVER_SLOTS.acquire(timeout=max(0, timeout)):
        raise httpcore.ConnectTimeout("model_resolution_timeout")
    result: queue.Queue[list[Any] | OSError] = queue.Queue(maxsize=1)

    def lookup() -> None:
        try:
            result.put(socket.getaddrinfo(host, port, type=socket.SOCK_STREAM))
        except OSError as exc:
            result.put(exc)
        finally:
            _RESOLVER_SLOTS.release()

    threading.Thread(target=lookup, daemon=True).start()
    try:
        addresses = result.get(timeout=max(0, timeout - (time.monotonic() - started)))
    except queue.Empty:
        raise httpcore.ConnectTimeout("model_resolution_timeout") from None
    if isinstance(addresses, OSError):
        raise httpcore.ConnectError("model_resolution_failed") from None
    if not addresses or any(not _public_ip(item[4][0]) for item in addresses):
        raise httpcore.ConnectError("unsafe_model_destination")
    return addresses


class PublicNetworkBackend(SyncBackend):
    """Resolve once, check every answer, and connect directly to that sockaddr."""

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> SyncStream:
        try:
            validate_public_host(host)
        except ValueError:
            raise httpcore.ConnectError("unsafe_model_destination") from None
        deadline = time.monotonic() + (timeout if timeout is not None else 5.0)
        addresses = _resolve(host, port, max(0, deadline - time.monotonic()))
        for family, socktype, protocol, _, sockaddr in addresses:
            if family not in {socket.AF_INET, socket.AF_INET6}:
                raise httpcore.ConnectError("unsafe_model_destination")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise httpcore.ConnectTimeout("model_connect_timeout")
            try:
                sock = socket.socket(family, socktype, protocol)
            except OSError:
                raise httpcore.ConnectError("model_connect_failed") from None
            try:
                sock.settimeout(remaining)
                for option in socket_options or ():
                    sock.setsockopt(*option)
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                # sockaddr came from the single vetted lookup; socket.connect
                # receives a numeric address, never an independently resolved host.
                sock.connect(sockaddr)
                return SyncStream(sock)
            except TimeoutError:
                sock.close()
                raise httpcore.ConnectTimeout("model_connect_timeout") from None
            except OSError:
                sock.close()
        raise httpcore.ConnectError("model_connect_failed")


class PublicHTTPTransport(httpx.HTTPTransport):
    """HTTPX adapter retaining its tested exception/stream handling.

    httpx has no public network-backend hook. Isolate the pool integration here;
    regression tests protect this boundary when the locked HTTP stack changes.
    """

    def __init__(self) -> None:
        self._pool = httpcore.ConnectionPool(
            ssl_context=httpx.create_ssl_context(verify=True, trust_env=False),
            network_backend=PublicNetworkBackend(),
            max_connections=8,
            max_keepalive_connections=0,
            retries=0,
        )
