"""FastAPI application factory and Uvicorn entry point."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import socket
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, Response
from starlette.requests import ClientDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import PROTOCOL_VERSION
from . import discovery
from .api.routes import router
from .backup import manager as backups
from .config import BACKEND_DIR, Settings, settings, local_ip
from .console import enable_utf8_output
from . import pairing
from .pair_page import render_pair_page
from .profile import build_profile
from .setup_page import render_setup_page
from .accept_loop import install as install_accept_resilience
from .database.db import init_db
from .disconnects import install as install_quiet_disconnects
from .security import LocalNetworkMiddleware, is_self_client

log = logging.getLogger("thoth")

FRONTEND_DIST = BACKEND_DIR.parent / "frontend" / "dist"


async def _auto_backup_loop(config: Settings) -> None:
    interval = max(1, int(config.auto_backup_hours)) * 3600
    while True:
        try:
            backups.create_backup(config, reason="automatic")
            log.info("Automatic backup written to %s", config.backup_dir)
        except Exception as exc:  # noqa: BLE001 - backups must never crash the server
            log.warning("Automatic backup failed: %s", exc)
        await asyncio.sleep(interval)


async def client_closed(_request: Request, _exc: Exception) -> JSONResponse:
    """A client that vanished mid-body: answer plainly, never a 500 traceback."""
    return JSONResponse({"detail": "client closed the connection"}, status_code=400)


def create_app(config: Settings | None = None) -> FastAPI:
    cfg = config or settings
    # A client resetting during accept must not leave the listener closed.
    install_accept_resilience()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # A browser closing a tab must not print a traceback; real errors still do.
        install_quiet_disconnects(asyncio.get_running_loop())
        init_db(cfg)
        cfg.ensure_token()
        cfg.save()
        if cfg.advertises_mdns:
            # Announces nota.local on the LAN so the iPad never needs an address.
            # Failure here is reported on /api/status, never fatal. It runs off the
            # event loop: zeroconf blocks while it registers, and doing that on the
            # loop starves it into an EventLoopBlocked timeout.
            await asyncio.to_thread(discovery.start, cfg)
        else:
            # A trusted address replaces the local name entirely: announcing it
            # would point the iPad at a certificate this build no longer uses.
            log.info("mDNS off: this server is reached through %s", cfg.base_url)
        task = asyncio.create_task(_auto_backup_loop(cfg))
        try:
            yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            await asyncio.to_thread(discovery.stop)

    app = FastAPI(
        title="NŌTA local server",
        version=str(PROTOCOL_VERSION),
        description="Offline-first notebook sync for one iPad and one Windows laptop.",
        lifespan=lifespan,
    )

    app.add_middleware(
        LocalNetworkMiddleware,
        token_provider=cfg.read_token,
        config=cfg,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.allowed_origins or [],
        allow_origin_regex=cfg.allow_origin_regex or None,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["X-Thoth-Token", "Content-Type", "X-Asset-Name"],
        # The iPad runs the app from GitHub Pages, so a cross-origin response
        # header reaches the screen only when it is named here: without this the
        # pairing pause would always fall back to "wait a minute".
        expose_headers=["Content-Disposition", "Retry-After"],
        max_age=600,
    )

    app.add_exception_handler(ClientDisconnect, client_closed)
    app.include_router(router)

    @app.get("/pair", include_in_schema=False)
    def pair_page(request: Request) -> HTMLResponse:
        host = request.client.host if request.client else None
        if not is_self_client(host):
            return HTMLResponse(
                "<h1>Pairing is only available on the laptop itself.</h1>",
                status_code=403,
            )
        return HTMLResponse(render_pair_page(cfg))

    @app.get("/setup", include_in_schema=False)
    def setup_page() -> HTMLResponse:
        """The iPad opens this to trust the laptop and download the profile."""
        return HTMLResponse(
            render_setup_page(cfg, machine=socket.gethostname()),
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/profile", include_in_schema=False)
    def trust_profile() -> Response:
        """The CA as an iOS configuration profile: what Settings can install.

        A bare certificate link is handled by Safari as a *file*: it is saved to
        Files and never offered as a profile, so no trust anchor is created and
        the iPad keeps refusing this laptop while the reader believes the
        certificate is installed. The mobileconfig is the shape iOS installs.
        """
        if cfg.tunneled:
            return JSONResponse(
                {
                    "detail": "No certificate is needed: this server is published behind a trusted address.",
                    "baseUrl": cfg.base_url,
                },
                status_code=404,
            )
        if not cfg.ca_file.exists():
            return JSONResponse({"detail": "certificate not generated yet"}, status_code=404)
        payload = build_profile(cfg.ca_file.read_bytes())
        return Response(
            content=payload,
            media_type="application/x-apple-aspen-config",
            headers={
                "Content-Disposition": 'attachment; filename="nota-local-ca.mobileconfig"',
                "Cache-Control": "no-store",
            },
        )

    @app.get("/ca", include_in_schema=False)
    def ca_profile() -> Response:
        """Serves the CA as a profile the iPad installs with two taps."""
        if cfg.tunneled:
            return JSONResponse(
                {
                    "detail": "No certificate is needed: this server is published behind a trusted address.",
                    "baseUrl": cfg.base_url,
                },
                status_code=404,
            )
        if not cfg.ca_file.exists():
            return JSONResponse({"detail": "certificate not generated yet"}, status_code=404)
        return FileResponse(
            cfg.ca_file,
            media_type="application/x-x509-ca-cert",
            filename="thoth-rootCA.cer",
            headers={
                "Content-Disposition": 'attachment; filename="thoth-rootCA.cer"',
                "Cache-Control": "no-store",
            },
        )

    if FRONTEND_DIST.exists():
        assets_dir = FRONTEND_DIST / "assets"
        if assets_dir.exists():
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            candidate = (FRONTEND_DIST / path).resolve()
            if (
                path
                and candidate.is_file()
                and FRONTEND_DIST.resolve() in candidate.parents
            ):
                return FileResponse(candidate)
            return FileResponse(FRONTEND_DIST / "index.html")

    return app


app = create_app()


def run() -> None:
    """Starts Uvicorn, terminating TLS locally only when no tunnel fronts us."""
    import uvicorn

    enable_utf8_output()
    cfg = settings
    init_db(cfg)
    cfg.ensure_token()

    if cfg.public_url_problem:
        print()
        print("  WARNING: the stored public_url was refused, so the LAN mode is in use.")
        print(f"           {cfg.public_url_problem}")
        print("           Store a good one with: python -m app.cli public-url https://your-address")

    fingerprint = ""
    if not cfg.tunneled:
        try:
            from .certs import ensure_certificates, fingerprint_of, missing_coverage

            issue = ensure_certificates(cfg)
            if issue.get("reissued"):
                log.info("Re-issued the server certificate for this machine's addresses")
            fingerprint = str(issue.get("fingerprint") or fingerprint_of(cfg))
        except RuntimeError as exc:  # cryptography missing
            log.warning("Certificate setup skipped: %s", exc)

    use_tls = cfg.tls
    scheme = "https" if use_tls else "http"
    # The laptop gets a plain HTTP door so it needs no certificate of any kind.
    laptop_app = cfg.laptop_app_url

    print()
    print("  NŌTA local server")
    print(f"  Data directory : {cfg.directory}")
    print(f"  iPad address   : {cfg.base_url}/")
    if cfg.tunneled:
        print(f"  Proxy side     : http://{cfg.listen_host}:{cfg.port}/  (loopback only: not on the Wi-Fi)")
    else:
        print(f"  LAN IP         : {local_ip()}:{cfg.port}")
        problem = missing_coverage(cfg)
        if problem:
            print("  WARNING        : " + problem)
    # A healthy server that Windows drops is the hardest failure to read: the
    # iPad says "cannot reach the laptop", and this laptop logs nothing at all.
    if not cfg.tunneled:
        try:
            from .netcheck import check as firewall_check

            blocked = firewall_check(cfg.port)
        except Exception:  # a diagnostic must never stop the server
            blocked = None
        if blocked:
            print("  WARNING        : the iPad cannot reach this server yet.")
            print(f"                   {blocked}")
    print(f"  Pairing code   : {pairing.current_code(cfg)}   (changes every {cfg.pair_code_minutes} min)")
    print(f"  Pairing page   : {laptop_app}/pair   (open on the laptop)")
    print(f"  App on laptop  : {laptop_app}/        (no certificate, pairs itself)")
    print("  Token          : stored locally in storage\\pairing-token.txt, never printed")
    print()
    if cfg.tunneled:
        print("  Trusted address in use: no certificate is needed on the iPad.")
        print(f"  iPad setup     : {cfg.setup_url}")
    elif use_tls:
        print("  First time on the iPad - nothing to send or copy:")
        print(f"    1. Open {cfg.setup_url} in Safari on the iPad")
        print("    2. Tap 'Download the profile', install it in Settings, then enable it")
        print("       under Certificate Trust Settings")
        print("    3. Tap 'Open NOTA' on that page: the laptop serves the app itself,")
        print("       then 'Find this laptop', and press Allow on the pairing page")
        print(f"  Certificate    : {fingerprint}")
    else:
        print("  WARNING: no TLS certificate yet. Installed iPad PWAs cannot call http:// endpoints.")
        print("           Run scripts\\install-windows.ps1 once to create it.")
    if FRONTEND_DIST.exists():
        print("  Served app     : bundled frontend at /")
    print()

    lan = uvicorn.Config(
        "app.main:app",
        # Behind a tunnel only the proxy may connect: the port never answers the
        # Wi-Fi. Without a trusted address the LAN keeps its usual address.
        host=cfg.listen_host,
        port=cfg.port,
        log_level="info",
        ssl_certfile=str(cfg.cert_file) if use_tls else None,
        ssl_keyfile=str(cfg.key_file) if use_tls else None,
    )
    if not use_tls or laptop_app.endswith(f":{cfg.port}"):
        uvicorn.Server(lan).run()
        return
    loopback = uvicorn.Config(
        "app.main:app",
        host="127.0.0.1",
        port=cfg.laptop_port,
        log_level="info",
        lifespan="off",  # the TLS server already started the app
    )
    _serve(lan, loopback)


def _serve(*configs) -> None:
    """Serves HTTPS for the LAN and plain HTTP for the laptop in one loop."""
    import uvicorn

    async def serve_all() -> None:
        await asyncio.gather(*(uvicorn.Server(config).serve() for config in configs))

    asyncio.run(serve_all())


if __name__ == "__main__":
    run()
