"""Who the device asking actually is.

Behind a tunnel every request arrives from loopback, so the address shown on the
pairing page is the one thing that makes ``Allow`` a decision rather than a
guess. That address has to stay correct in both modes, and a client that is not
proxied must never be able to write it.
"""

from __future__ import annotations

from starlette.requests import Request

from app.security import client_address, is_proxy_peer, is_trusted_client


def request_from(peer: str, forwarded: str | None = None) -> Request:
    headers = []
    if forwarded is not None:
        headers.append((b"x-forwarded-for", forwarded.encode("utf-8")))
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/api/pair/request",
            "raw_path": b"/api/pair/request",
            "query_string": b"",
            "root_path": "",
            "headers": headers,
            "client": (peer, 51234),
            "server": ("127.0.0.1", 8443),
        }
    )


def test_a_direct_client_is_itself_whatever_it_claims_in_the_header():
    assert client_address(request_from("192.168.2.50", "8.8.8.8")) == "192.168.2.50"


def test_a_proxy_on_this_machine_speaks_for_the_device_behind_it():
    assert is_proxy_peer("127.0.0.1") is True
    assert is_proxy_peer("192.168.2.50") is False
    assert client_address(request_from("127.0.0.1", "192.168.1.20")) == "192.168.1.20"


def test_the_entry_the_proxy_appended_wins_over_one_the_client_invented():
    # Proxies append; a client can only prepend. Reading from the right is what
    # keeps a forged "1.2.3.4" from being shown as the device asking.
    chain = "1.2.3.4, 192.168.1.20"
    assert client_address(request_from("127.0.0.1", chain)) == "192.168.1.20"


def test_a_port_or_ipv6_bracket_is_not_part_of_the_address():
    assert client_address(request_from("127.0.0.1", "192.168.1.20:5555")) == "192.168.1.20"
    assert client_address(request_from("127.0.0.1", "[2001:db8::7]:5555")) == "2001:db8::7"


def test_an_unreadable_header_falls_back_to_the_proxy_itself():
    assert client_address(request_from("127.0.0.1", "unknown")) == "127.0.0.1"
    assert client_address(request_from("127.0.0.1")) == "127.0.0.1"


def test_a_tailnet_address_is_still_a_private_client():
    # Python 3.13+ no longer calls 100.64.0.0/10 private, but a tailnet is a
    # private overlay between the user's own devices, never the open Internet.
    assert is_trusted_client("100.64.0.1") is True
    assert is_trusted_client("100.101.102.103") is True
    assert is_trusted_client("100.128.0.1") is False
    assert is_trusted_client("8.8.8.8") is False
    assert is_trusted_client("192.168.2.50") is True
    assert is_trusted_client("127.0.0.1") is True
    assert is_trusted_client("fe80::1") is True
    assert is_trusted_client(None) is False
