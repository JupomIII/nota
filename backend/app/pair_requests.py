"""Pairing by approval: the laptop sees the iPad appear and says yes.

The QR code and the six-character code both make the iPad carry a secret away
from the laptop's screen. This module turns it around. The iPad asks this
laptop to pair, the pairing page on the laptop shows the device that asked and
one button, and only after that does the token leave the machine.

Nothing from the request body is trusted except a display label: it names the
device in the list and never reaches storage. The token is handed out exactly
once, to whoever holds the request id, over the same private network and TLS
connection the rest of the sync uses.
"""

from __future__ import annotations

import math
import secrets
import time
from dataclasses import dataclass, field

# A request that nobody answered is noise: it dies before the reader has time to
# worry about a stranger queued on the laptop.
REQUEST_TTL = 300.0
MAX_PENDING = 8
MAX_PER_CLIENT = 6
CREATE_WINDOW = 600.0
LABEL_LIMIT = 48


@dataclass
class PairAsk:
    id: str
    label: str
    address: str
    created: float
    state: str = "pending"  # pending | allowed | denied | claimed
    # The app's own id, forwarded so the granted token replaces the device's
    # previous one instead of adding a second row on every re-pairing.
    device_key: str = ""


_asks: dict[str, PairAsk] = {}
_creations: dict[str, list[float]] = {}


def _now() -> float:
    # A function, not time.time() inline, so tests can move the clock.
    return time.time()


def _clean_label(raw: str) -> str:
    text = " ".join(str(raw or "").split())
    text = "".join(ch for ch in text if ch.isprintable())
    return (text[:LABEL_LIMIT] or "A device").strip()


def _prune(moment: float) -> None:
    for key in [key for key, ask in _asks.items() if moment - ask.created > REQUEST_TTL]:
        _asks.pop(key, None)
    for client, stamps in list(_creations.items()):
        recent = [stamp for stamp in stamps if moment - stamp < CREATE_WINDOW]
        if recent:
            _creations[client] = recent
        else:
            _creations.pop(client, None)


def allow_create(client: str) -> bool:
    moment = _now()
    _prune(moment)
    return len(_creations.get(client, [])) < MAX_PER_CLIENT


def retry_after(client: str) -> int:
    """Seconds until this client may knock again; 0 when it may already.

    The rate limit is a sliding window, so the honest answer is not the whole
    window: it is the moment the oldest of the attempts filling it ages out.
    """
    moment = _now()
    _prune(moment)
    stamps = sorted(_creations.get(client, []))
    if len(stamps) < MAX_PER_CLIENT:
        return 0
    oldest = stamps[-MAX_PER_CLIENT]
    return max(1, math.ceil(CREATE_WINDOW - (moment - oldest)))


def create(label: str, client: str, device_key: str = "") -> PairAsk:
    moment = _now()
    _prune(moment)
    _creations.setdefault(client, []).append(moment)

    pending = [ask for ask in _asks.values() if ask.state == "pending"]
    while len(pending) >= MAX_PENDING:
        oldest = min(pending, key=lambda ask: ask.created)
        _asks.pop(oldest.id, None)
        pending = [ask for ask in pending if ask.id != oldest.id]

    ask = PairAsk(
        id=secrets.token_urlsafe(24),
        label=_clean_label(label),
        address=str(client or ""),
        created=moment,
        device_key="".join(ch for ch in str(device_key or "") if ch.isprintable())[:128],
    )
    _asks[ask.id] = ask
    return ask


def open_asks() -> list[PairAsk]:
    """What the pairing page lists: unanswered requests, newest first."""
    moment = _now()
    _prune(moment)
    pending = [ask for ask in _asks.values() if ask.state == "pending"]
    return sorted(pending, key=lambda ask: ask.created, reverse=True)


def decide(request_id: str, allow: bool) -> PairAsk | None:
    """Records the laptop's answer. Only a waiting request can be answered."""
    moment = _now()
    _prune(moment)
    ask = _asks.get(request_id)
    if ask is None or ask.state != "pending":
        return None
    ask.state = "allowed" if allow else "denied"
    return ask


def claim(request_id: str) -> tuple[PairAsk | None, bool]:
    """The iPad asking for its answer.

    Returns the request and whether this call is the one that may take the
    token: an allowed request grants it once, so a replayed poll learns the
    state but nothing else.
    """
    moment = _now()
    _prune(moment)
    ask = _asks.get(request_id)
    if ask is None:
        return None, False
    if ask.state != "allowed":
        return ask, False
    ask.state = "claimed"
    return ask, True


def reset() -> None:
    """Testing hook: forget every request and every rate-limit stamp."""
    _asks.clear()
    _creations.clear()
