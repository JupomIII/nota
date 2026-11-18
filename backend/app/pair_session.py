"""One-time pairing sessions.

The laptop shows a QR code that carries a 256-bit secret, the address it is
reachable on, and the identity of the session. The iPad never sends that secret
back: it proves it knows it with an HMAC over the session id, so what crosses
the network is a proof, not the credential.

Both screens then show the same five-character code. It is derived from the
secret, it is only there for a pair of human eyes to compare, and it can never
be used to pair on its own.

A session is single use and dies after five minutes. Three wrong proofs
invalidate every open session, so the laptop has to show a fresh QR code before
anyone may try again.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlencode

# Short on purpose: a QR left on a screen overnight is not a credential.
SESSION_TTL = 300.0
MAX_ATTEMPTS = 3
# No 0, O, 1, I or L: the point of this code is being read out loud or compared
# across two screens, so the ambiguous glyphs are gone.
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 5
# 32 bytes is 256 bits: twice the 128-bit floor, and still 43 URL-safe
# characters, which keeps the QR code small.
SECRET_BYTES = 32

PROOF_PREFIX = "nota-pair"


@dataclass
class PairSession:
    """One QR code: a secret, the short code derived from it, and its clock."""

    id: str
    secret: str
    code: str
    created: float
    attempts: int = 0
    used: bool = False

    def expired(self, moment: float) -> bool:
        return moment - self.created > SESSION_TTL


_sessions: dict[str, PairSession] = {}


def _now() -> float:
    # A function, not time.time() inline, so tests can move the clock.
    return time.time()


def _prune(moment: float) -> None:
    # A used or expired session lingers a little so the answer can say *why* it
    # was refused instead of a flat "unknown".
    for key in [key for key, item in _sessions.items() if moment - item.created > SESSION_TTL + 60]:
        _sessions.pop(key, None)


def short_code(secret: str) -> str:
    """Five characters for the human check, derived from the secret.

    Deterministic on both sides, but one-way: seeing the code tells nothing
    about the secret, and the code alone cannot pair anything.
    """
    digest = hmac.new(secret.encode("utf-8"), b"nota-pair-confirm", hashlib.sha256).digest()
    return "".join(ALPHABET[value % len(ALPHABET)] for value in digest[:CODE_LENGTH])


def proof_for(secret: str, session_id: str) -> str:
    """What the iPad sends: knowledge of the secret, not the secret.

    The session id is inside the signed message, so a proof captured for one
    session is worthless for the next one.
    """
    return hmac.new(
        secret.encode("utf-8"),
        f"{PROOF_PREFIX}:{session_id}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def start() -> PairSession:
    """The session the laptop is currently showing.

    Idempotent while a session is still usable: the pairing page polls this
    endpoint, and a new secret on every poll would make the QR code unreadable.
    """
    moment = _now()
    _prune(moment)
    for session in _sessions.values():
        if not session.used and not session.expired(moment):
            return session
    secret = secrets.token_urlsafe(SECRET_BYTES)
    session = PairSession(
        id=secrets.token_urlsafe(12),
        secret=secret,
        code=short_code(secret),
        created=moment,
    )
    _sessions[session.id] = session
    return session


def current() -> PairSession | None:
    moment = _now()
    _prune(moment)
    for session in _sessions.values():
        if not session.used and not session.expired(moment):
            return session
    return None


def seconds_left(session: PairSession) -> int:
    return max(0, int(SESSION_TTL - (_now() - session.created)))


def link(cfg, session: PairSession) -> str:
    """The QR payload, with the secret in the fragment.

    A fragment is never sent to a server and never appears in a request line or
    a log, which is exactly what this secret needs. The app reads it locally and
    turns it into a proof.
    """
    query = urlencode({"server": cfg.base_url, "i": session.id, "s": session.secret})
    return f"{cfg.base_url.rstrip('/')}/#/sync?{query}"


def claim(session_id: str, proof: str) -> tuple[str, PairSession | None]:
    """Checks a proof. Returns a state the route turns into one sentence.

    States: ``ok``, ``refused``, ``locked``, ``expired``, ``used``, ``unknown``.
    """
    moment = _now()
    _prune(moment)
    session = _sessions.get(session_id)
    if session is None:
        return "unknown", None
    if session.used:
        return "used", session
    if session.expired(moment):
        return "expired", session
    if session.attempts >= MAX_ATTEMPTS:
        return "locked", session
    expected = proof_for(session.secret, session.id)
    if not hmac.compare_digest(expected, (proof or "").strip().lower()):
        session.attempts += 1
        if session.attempts >= MAX_ATTEMPTS:
            # One QR code buys three attempts. Any further try needs the laptop
            # to show a new one, so guessing has a hard ceiling.
            reset()
            return "locked", session
        return "refused", session
    session.used = True
    return "ok", session


def reset() -> None:
    """Testing hook, and the invalidation the third wrong proof triggers."""
    _sessions.clear()
