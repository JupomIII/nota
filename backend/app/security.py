"""LAN-only access control and pairing-token authentication."""

from __future__ import annotations

import ipaddress
import secrets
from typing import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from . import devices

# Paths that carry no token. The pairing endpoints are here on purpose: the
# device that wants the token cannot hold one yet. Each route decides for
# itself who may call it — ``/api/pair/requests`` and its decisions check that
# the caller is the laptop, while the iPad's poll knows only an unguessable id.
PUBLIC_PATHS = {
    "/api/health",
    "/api/pair",
    "/api/pair/link",
    "/api/pair/qr",
    "/api/pair/request",
    "/api/pair/session",
    "/api/pair/requests",
}
PUBLIC_PREFIXES = ("/api/pair/request/", "/api/pair/requests/")

# The range a tailnet uses. Python 3.13+ stopped calling the shared address
# space "private" (RFC 6890 lists it separately), yet it is a private overlay
# between the user's own devices, never the public Internet.
SHARED_ADDRESS_SPACE = ipaddress.ip_network("100.64.0.0/10")

FORWARDED_FOR = "x-forwarded-for"


def is_public_path(path: str) -> bool:
    if path in PUBLIC_PATHS:
        return True
    return any(path.startswith(prefix) for prefix in PUBLIC_PREFIXES)


def _address_of(host: str | None) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """One parser for every caller, so the rules below cannot drift apart."""
    if not host:
        return None
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return None
    if address.version == 6 and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def is_trusted_client(host: str | None) -> bool:
    if not host:
        return False
    if host in {"testclient", "localhost"}:
        return True
    address = _address_of(host)
    if address is None:
        return False
    if address.is_loopback or address.is_private or address.is_link_local:
        return True
    return address.version == 4 and address in SHARED_ADDRESS_SPACE


def is_self_client(host: str | None) -> bool:
    """True when the request comes from the machine running the server."""
    if not host:
        return False
    if host in {"testclient", "localhost"}:
        return True
    address = _address_of(host)
    if address is None:
        return False
    if address.is_loopback:
        return True
    from .config import local_ip

    return str(address) == local_ip()


def is_proxy_peer(host: str | None) -> bool:
    """True for a proxy running on this machine (tailscale serve, cloudflared).

    Only such a peer is allowed to say who the real client is: anything else
    reaching us directly could invent the header, so its word is ignored.
    """
    if not host:
        return False
    if host in {"testclient", "localhost"}:
        return True
    address = _address_of(host)
    return bool(address is not None and address.is_loopback)


def _without_port(value: str) -> str:
    """``1.2.3.4:5678`` and ``[2001:db8::1]:443`` become bare addresses."""
    text = value.strip()
    if text.startswith("["):
        end = text.find("]")
        return text[1:end] if end > 0 else text
    if text.count(":") == 1:
        host, _, port = text.partition(":")
        if port.isdigit():
            return host
    return text


def client_address(request: Request) -> str:
    """The device that asked, rather than the proxy standing in front of it.

    Behind a tunnel every request arrives from loopback, which would make the
    pairing list show ``127.0.0.1`` for every device — useless for the one
    decision the list exists to support. The proxy appends the address it saw,
    so the right-most usable entry is the truth; anything the client prepended
    to that header is ignored. A client that is not proxied is never asked.
    """
    peer = request.client.host if request.client else ""
    if not is_proxy_peer(peer):
        return peer
    for entry in reversed(request.headers.get(FORWARDED_FOR, "").split(",")):
        address = _address_of(_without_port(entry))
        if address is not None:
            return str(address)
    return peer


class LocalNetworkMiddleware(BaseHTTPMiddleware):
    """Rejects public clients outright and requires the pairing token for APIs."""

    def __init__(self, app: Callable[..., Awaitable[Response]], token_provider, config) -> None:
        super().__init__(app)
        self.token_provider = token_provider
        self.config = config

    async def dispatch(self, request: Request, call_next):
        client_host = request.client.host if request.client else None
        if not is_trusted_client(client_host):
            return JSONResponse(
                {"detail": "This server only accepts private network clients."}, status_code=403
            )

        path = request.url.path
        if path.startswith("/api") and not is_public_path(path):
            expected = self.token_provider()
            provided = request.headers.get("x-thoth-token", "")
            allowed = (
                bool(expected)
                and bool(provided)
                and secrets.compare_digest(expected, provided)
            )
            # A device paired through a QR code carries its own token, so one
            # device can be revoked without locking the others out.
            if not allowed and not devices.token_valid(provided):
                # A revoked device deserves a true sentence: its token is not
                # wrong, the device was removed on the laptop.
                if devices.lookup(provided) == "revoked":
                    return JSONResponse(
                        {
                            "detail": "This device was removed on the laptop.",
                            "code": "revoked",
                        },
                        status_code=401,
                    )
                return JSONResponse({"detail": "Invalid or missing pairing token."}, status_code=401)

        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        return response


def allowed_origin_regex(config) -> str | None:
    # Browsers omit Origin for same-origin requests, so the app served by this
    # server works without any CORS entry at all.
    return config.allow_origin_regex if getattr(config, "allow_origin_regex", None) else None
