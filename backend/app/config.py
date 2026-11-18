"""Server configuration: files live under a single writable data directory."""

from __future__ import annotations

import json
import logging
import os
import socket
from dataclasses import dataclass, field, asdict, fields
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

log = logging.getLogger("thoth.config")

BACKEND_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DATA_DIR = BACKEND_DIR / "storage"

# The name the laptop advertises over mDNS. Safari cannot browse Bonjour, but it
# can resolve a name the network already answers for, so this one is the anchor
# that survives every address change.
MDNS_HOST = "nota.local"

PUBLIC_URL_HELP = (
    "Use the address your tunnel or reverse proxy gives you, with no path: "
    "for example https://jps-laptop.tailnet-name.ts.net"
)


class ConfigError(ValueError):
    """A setting the server refuses, with a message a person can act on."""


def normalize_public_url(raw: str | None) -> str:
    """Validates and canonicalises the trusted address, or returns ``""``.

    HTTPS is mandatory rather than preferred: iOS blocks plain ``http://`` calls
    from an installed web app, so accepting one here would only move the failure
    onto Safari on the iPad, where it reads as "the laptop is asleep".
    """
    value = str(raw or "").strip()
    if not value:
        return ""
    if any(char.isspace() for char in value):
        raise ConfigError(f"the address contains a space ({value!r}). {PUBLIC_URL_HELP}")
    parts = urlsplit(value)
    scheme = parts.scheme.lower()
    if scheme != "https":
        found = f"{scheme}://" if scheme else "no scheme at all"
        raise ConfigError(
            f"expected an https:// address, but got {found} in {value!r}. "
            f"A plain http:// address fails on the iPad, so it is refused here "
            f"instead of failing there. {PUBLIC_URL_HELP}"
        )
    if not parts.hostname:
        raise ConfigError(f"the address has no host ({value!r}). {PUBLIC_URL_HELP}")
    if parts.username or parts.password:
        raise ConfigError(
            f"the address must not carry a username or password ({value!r})."
        )
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        raise ConfigError(
            f"the address must be the server's bare root, without a path, query or "
            f"fragment (got {value!r}). {PUBLIC_URL_HELP}"
        )
    try:
        port = parts.port
    except ValueError:
        raise ConfigError(
            f"the port in {value!r} is not a number between 1 and 65535."
        ) from None
    host = parts.hostname or ""
    netloc = f"[{host}]" if ":" in host else host
    if port is not None:
        netloc = f"{netloc}:{port}"
    # Rebuilt from the parts: no trailing slash survives, the host is lower case.
    return f"https://{netloc}"


def data_dir() -> Path:
    override = os.environ.get("THOTH_DATA_DIR")
    path = Path(override).expanduser() if override else DEFAULT_DATA_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def local_ip() -> str:
    """Best-effort LAN address without sending packets anywhere."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("192.0.2.1", 9))
            return sock.getsockname()[0]
    except OSError:
        try:
            return socket.gethostbyname(socket.gethostname())
        except OSError:
            return "127.0.0.1"


def host_name() -> str:
    return os.environ.get("COMPUTERNAME") or socket.gethostname()


def server_identity() -> str:
    """Stable identity of this server, deliberately unrelated to any address.

    The iPad keeps its pairing next to this id instead of next to an IP, so a
    new network reconnects to the same server rather than to a stranger that
    happens to hold the old address.
    """
    path = data_dir() / "server-id.txt"
    try:
        existing = path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    except OSError:
        pass
    import secrets

    value = secrets.token_hex(16)
    try:
        path.write_text(value + "\n", encoding="utf-8")
    except OSError:
        pass
    return value


@dataclass
class Settings:
    host: str = "0.0.0.0"
    port: int = 8443
    # Plain HTTP on the loopback interface: the laptop opens this and never sees
    # a certificate warning. Browsers treat http://localhost as a secure context,
    # so the service worker and offline storage work there too.
    laptop_port: int = 8080
    # Same-origin requests never need CORS; these cover the GitHub Pages app and
    # a local Vite dev server. Add your own origin in storage/config.json.
    allowed_origins: list[str] = field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"]
    )
    # One origin, not every GitHub Pages site: ``/api/pair/link`` answers only
    # loopback callers, and a page in the laptop's own browser *is* a loopback
    # caller. With a wildcard, any user's github.io page could read that link
    # and exchange its code for the token. A different deployment changes this.
    allow_origin_regex: str = r"https://jupomiii\.github\.io"
    # Legacy: the published copy of the app. The pairing link now opens the app
    # this server serves, on its own origin, so a stale deployment can never be
    # what the iPad loads; this value is kept only for older config files.
    pair_app_url: str = "https://jupomiii.github.io/nota"
    # Optional trusted HTTPS address for this server (Tailscale, Cloudflare
    # tunnel, reverse proxy). When set, the server speaks plain HTTP on the loop
    # back side of the tunnel and no local certificate is used at all.
    public_url: str = ""
    # Filled at load time when the stored address is unusable: the value is
    # dropped so the LAN mode stays whole, and this explains why to the console.
    # Derived, never written back to the file.
    public_url_problem: str = ""
    ca_valid_days: int = 1825
    leaf_valid_days: int = 397
    pair_code_minutes: int = 30
    rotate_keep: int = 7
    auto_backup_hours: int = 24
    max_json_bytes: int = 4 * 1024 * 1024
    max_asset_bytes: int = 120 * 1024 * 1024

    @property
    def directory(self) -> Path:
        return data_dir()

    @property
    def db_path(self) -> Path:
        return self.directory / "thoth.db"

    @property
    def blob_dir(self) -> Path:
        path = self.directory / "blobs"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def backup_dir(self) -> Path:
        path = self.directory / "backups"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def cert_dir(self) -> Path:
        path = self.directory / "certs"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def token_path(self) -> Path:
        return self.directory / "pairing-token.txt"

    @property
    def config_path(self) -> Path:
        return self.directory / "config.json"

    @property
    def cert_file(self) -> Path:
        return self.cert_dir / "server-cert.pem"

    @property
    def key_file(self) -> Path:
        return self.cert_dir / "server-key.pem"

    @property
    def ca_file(self) -> Path:
        return self.cert_dir / "thoth-rootCA.cer"

    @property
    def ca_pem(self) -> Path:
        return self.cert_dir / "thoth-rootCA.pem"

    @property
    def ca_key_file(self) -> Path:
        return self.cert_dir / "ca-key.pem"

    @property
    def tunneled(self) -> bool:
        """True when a public HTTPS address fronts this server."""
        return bool(str(self.public_url).strip())

    @property
    def tls(self) -> bool:
        """True when Uvicorn should terminate TLS itself."""
        return (
            not self.tunneled
            and self.cert_file.exists()
            and self.key_file.exists()
        )

    @property
    def base_url(self) -> str:
        if self.tunneled:
            return str(self.public_url).strip().rstrip("/")
        scheme = "https" if self.tls else "http"
        return f"{scheme}://{local_ip()}:{self.port}"

    @property
    def server_id(self) -> str:
        return server_identity()

    @property
    def advertises_mdns(self) -> bool:
        """False behind a trusted address: there is no local name to advertise.

        Announcing ``nota.local`` there would hand the iPad a name whose TLS
        certificate is the local one it no longer trusts, so every reconnect
        would spend its first seconds on a name that can only fail.
        """
        return not self.tunneled

    @property
    def listen_host(self) -> str:
        """Loopback behind a tunnel: the proxy is then the only way in.

        The LAN keeps its own address exactly as before; with a trusted address
        the plain-HTTP port never becomes reachable from the Wi-Fi at all.
        """
        return "127.0.0.1" if self.tunneled else self.host

    def set_public_url(self, raw: str | None) -> str:
        """Stores a validated trusted address; an invalid one changes nothing."""
        value = normalize_public_url(raw)
        self.public_url = value
        self.public_url_problem = ""
        return value

    @property
    def mdns_url(self) -> str:
        """Address on the local network that does not depend on DHCP."""
        if not self.advertises_mdns:
            return ""
        scheme = "https" if self.tls else "http"
        return f"{scheme}://{MDNS_HOST}:{self.port}"

    @property
    def laptop_url(self) -> str:
        return f"http://localhost:{self.laptop_port}"

    @property
    def laptop_app_url(self) -> str:
        """Where the laptop opens the app: plain HTTP whenever TLS is used."""
        if self.tls and not self.tunneled:
            return self.laptop_url
        return f"http://localhost:{self.port}"

    @property
    def setup_url(self) -> str:
        return f"{self.base_url}/setup"

    def load(self) -> "Settings":
        raw: dict[str, Any] = {}
        if self.config_path.exists():
            try:
                loaded = json.loads(self.config_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                loaded = {}
            if isinstance(loaded, dict):
                raw = loaded
            known = {item.name for item in fields(self)}
            for key, value in raw.items():
                # Only real settings: a stray key must neither crash the server
                # (properties have no setter) nor silently win over the file.
                if key in known and key not in {"public_url", "public_url_problem"}:
                    setattr(self, key, value)
        self.public_url = ""
        self.public_url_problem = ""
        if "public_url" in raw:
            try:
                self.public_url = normalize_public_url(raw.get("public_url"))
            except ConfigError as exc:
                # Refused, not half-applied: the server runs its ordinary LAN
                # mode and says exactly why the stored address was ignored.
                self.public_url_problem = str(exc)
                log.warning("Ignoring public_url in %s: %s", self.config_path, exc)
        if os.environ.get("THOTH_PORT"):
            self.port = int(os.environ["THOTH_PORT"])
        if os.environ.get("THOTH_ALLOWED_ORIGINS"):
            self.allowed_origins = [
                origin.strip()
                for origin in os.environ["THOTH_ALLOWED_ORIGINS"].split(",")
                if origin.strip()
            ]
        return self

    def save(self) -> None:
        payload = asdict(self)
        # Recomputed by load(); writing it would turn a report into a setting.
        payload.pop("public_url_problem", None)
        self.config_path.write_text(
            json.dumps(payload, indent=2),
            encoding="utf-8",
        )

    def ensure_token(self) -> str:
        if self.token_path.exists():
            token = self.token_path.read_text(encoding="utf-8").strip()
            if token:
                return token
        import secrets

        token = secrets.token_urlsafe(32)
        self.token_path.write_text(token + "\n", encoding="utf-8")
        try:
            os.chmod(self.token_path, 0o600)
        except OSError:
            pass
        return token

    def read_token(self) -> str:
        if not self.token_path.exists():
            return ""
        return self.token_path.read_text(encoding="utf-8").strip()


settings = Settings().load()
