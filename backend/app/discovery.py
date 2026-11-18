"""mDNS/Bonjour advertisement so the iPad finds this laptop by name.

A browser cannot browse Bonjour services, and Safari offers no API for it. What
Safari *can* do is resolve a host name that the network already advertises, so
the published app asks for ``https://nota.local:<port>`` and the responder here
answers with whichever address this machine currently holds. That is what makes
the address changes invisible: the name stays, the address behind it moves.

The advertisement is best-effort. Without the ``zeroconf`` package, or on a
network that blocks multicast, the server keeps working and the app falls back
to the address that worked last time.
"""

from __future__ import annotations

import logging
import socket
import threading
from typing import Any

from .config import MDNS_HOST, Settings, local_ip, server_identity

log = logging.getLogger("thoth.discovery")

SERVICE_TYPE = "_nota._tcp.local."
ANNOUNCE_SECONDS = 20.0


def _advertisable_addresses() -> list[str]:
    """Every LAN IPv4 address this machine holds, loopback excluded.

    A laptop docked to Ethernet while still on Wi-Fi has two, and either may be
    the one the iPad can reach, so both are published.
    """
    found: list[str] = []
    try:
        import ifaddr  # bundled with zeroconf
    except ImportError:
        found = [local_ip()]
    else:
        for adapter in ifaddr.get_adapters():
            for entry in adapter.ips:
                value = entry.ip
                if not isinstance(value, str):
                    continue
                address = value.split("%")[0]
                if not address or address.startswith("127.") or address == "0.0.0.0":
                    continue
                # 169.254.x.x means DHCP failed: useless to the iPad.
                if address.startswith("169.254."):
                    continue
                if address not in found:
                    found.append(address)
    if not found:
        fallback = local_ip()
        if fallback:
            found = [fallback]
    return found


def _service_port(cfg: Settings) -> int:
    """The port the iPad should talk to: TLS on the LAN, plain HTTP if no cert."""
    return int(cfg.port if cfg.tls else cfg.port)


class Discovery:
    """Owns the mDNS responder for the lifetime of the server process."""

    def __init__(self, cfg: Settings) -> None:
        self.cfg = cfg
        self.state = "stopped"
        self.detail = ""
        self.addresses: list[str] = []
        self._zc: Any = None
        self._info: Any = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    # -- reporting ---------------------------------------------------
    @property
    def url(self) -> str:
        scheme = "https" if self.cfg.tls else "http"
        return f"{scheme}://{MDNS_HOST}:{self.cfg.port}"

    def describe(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "detail": self.detail,
            "hostname": MDNS_HOST,
            "url": self.url,
            "service": SERVICE_TYPE,
            "addresses": list(self.addresses),
        }

    # -- lifecycle ---------------------------------------------------
    def start(self) -> None:
        if self.state in {"advertising", "starting"}:
            return
        try:
            from zeroconf import ServiceInfo, Zeroconf
        except ImportError:
            self.state = "unavailable"
            self.detail = (
                "The 'zeroconf' package is not installed, so the laptop is not "
                "announcing itself. Install it with: pip install zeroconf"
            )
            log.warning("mDNS disabled: %s", self.detail)
            return

        self.state = "starting"
        try:
            self._zc = Zeroconf()
            self._publish(ServiceInfo)
        except Exception as exc:  # noqa: BLE001 - discovery must never stop the server
            self.state = "error"
            # repr, not str: zeroconf raises exceptions with an empty message and
            # the class name is the only clue left.
            self.detail = f"{type(exc).__name__}: {exc}".strip()
            log.exception("mDNS advertisement failed (%s)", self.detail)
            self._close()
            return
        self.state = "advertising"
        self.detail = ""
        log.info("Announcing %s as %s", SERVICE_TYPE, self.url)
        self._thread = threading.Thread(target=self._watch_network, name="thoth-mdns", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        self._thread = None
        if thread is not None and thread.is_alive():
            thread.join(timeout=2)
        self._close()
        self.state = "stopped"

    def _close(self) -> None:
        zc = self._zc
        self._zc = None
        info = self._info
        self._info = None
        if zc is None:
            return
        try:
            if info is not None:
                zc.unregister_service(info)
        except Exception:  # noqa: BLE001 - shutting down anyway
            pass
        try:
            zc.close()
        except Exception:  # noqa: BLE001
            pass

    # -- internals ---------------------------------------------------
    def _publish(self, service_info_cls) -> None:
        """Registers the service under the fixed ``nota.local`` host name."""
        addresses = _advertisable_addresses()
        if not addresses:
            raise RuntimeError("no LAN address to advertise")
        payload = {
            "id": server_identity(),
            "name": socket.gethostname(),
            "scheme": "https" if self.cfg.tls else "http",
            # The address the iPad should open: this server serves the app
            # itself, so the record never points at the old published copy.
            "app": str(self.cfg.base_url),
        }
        info = service_info_cls(
            type_=SERVICE_TYPE,
            name=f"{socket.gethostname()}.{SERVICE_TYPE}",
            addresses=[socket.inet_aton(address) for address in addresses],
            port=_service_port(self.cfg),
            properties={key: value.encode("utf-8") for key, value in payload.items()},
            # The fixed name is the point: an address can change, this cannot.
            server=f"{MDNS_HOST}.",
        )
        zc = self._zc
        assert zc is not None
        zc.register_service(info)
        self._info = info
        self.addresses = addresses

    def _watch_network(self) -> None:
        """Re-announces when the laptop's address changes or a network appears.

        DHCP reassignment, Wi-Fi to Ethernet, coming back from sleep: the name
        an iPad resolved a minute ago has to point somewhere new, and the
        responder has to notice without a restart.
        """
        last = list(self.addresses)
        while not self._stop.wait(ANNOUNCE_SECONDS):
            current = _advertisable_addresses()
            if current == last:
                try:
                    if self._zc is not None:
                        self._zc.update_interfaces()
                except Exception:  # noqa: BLE001
                    pass
                continue
            try:
                from zeroconf import ServiceInfo

                old = self._info
                if self._zc is not None and old is not None:
                    self._zc.unregister_service(old)
                self._publish(ServiceInfo)
                last = current
                log.info("LAN address changed, re-announcing %s on %s", MDNS_HOST, current)
            except Exception as exc:  # noqa: BLE001
                self.state = "error"
                self.detail = f"{type(exc).__name__}: {exc}".strip()
                log.exception("mDNS re-announce failed (%s)", self.detail)
                return


_advertiser: Discovery | None = None


def start(cfg: Settings) -> Discovery:
    global _advertiser
    if _advertiser is None:
        _advertiser = Discovery(cfg)
        _advertiser.start()
    return _advertiser


def stop() -> None:
    global _advertiser
    if _advertiser is not None:
        _advertiser.stop()
        _advertiser = None


def describe() -> dict[str, Any]:
    if _advertiser is None:
        return {
            "state": "stopped",
            "detail": "Not started",
            "hostname": MDNS_HOST,
            "url": "",
            "service": SERVICE_TYPE,
            "addresses": _advertisable_addresses(),
        }
    return _advertiser.describe()
