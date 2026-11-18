"""Whether Windows lets the iPad in at all (read-only).

A server can be perfectly healthy and still unreachable. An inbound firewall
rule drops every packet before the request is logged, so the laptop's own log
shows nothing and the iPad can only say "cannot reach the laptop". Windows
classifies a home Wi-Fi as *Public* by default, where the project's own rule
(private networks only) does not apply — and an explicit Block rule wins over
every Allow rule for the same program.

Nothing here changes a setting: it reads ``netsh`` and returns one sentence the
server window can print, so nobody is sent looking at certificates that were
never the problem.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

FIELD = re.compile(r"^(Rule Name|Enabled|Direction|Profiles|LocalPort|Program|Action)\s*:\s*(.+)$")
SECTION = re.compile(r"^(Domain|Private|Public) Profile Settings\s*:", re.IGNORECASE)
ALL_PROFILES = frozenset({"domain", "private", "public"})


@dataclass(frozen=True)
class Rule:
    name: str
    enabled: bool
    inbound: bool
    profiles: frozenset[str]
    action: str
    program: str
    port: str


def _squash(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _profiles(value: str) -> frozenset[str]:
    words = {part.strip().lower() for part in value.split(",") if part.strip()}
    if not words or "any" in words:
        return ALL_PROFILES
    return frozenset(words)


def parse_rules(text: str) -> list[Rule]:
    """The inbound rules in the verbose ``show rule`` listing."""
    rules: list[Rule] = []
    fields: dict[str, str] = {}

    def flush() -> None:
        if "Action" not in fields:
            fields.clear()
            return
        rules.append(
            Rule(
                name=fields.get("Rule Name", ""),
                enabled=fields.get("Enabled", "").strip().lower() == "yes",
                inbound=fields.get("Direction", "").strip().lower().startswith("in"),
                profiles=_profiles(fields.get("Profiles", "")),
                action=fields.get("Action", "").strip().lower(),
                program=_squash(fields.get("Program", "")),
                port=fields.get("LocalPort", "").strip(),
            )
        )
        fields.clear()

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        match = FIELD.match(line)
        if not match:
            continue
        key, value = match.group(1), match.group(2)
        if key == "Rule Name" and fields:
            flush()
        fields[key] = value
    flush()
    return rules


def active_profiles(text: str) -> frozenset[str]:
    """The profiles the firewall is filtering right now (``State ON``)."""
    found: set[str] = set()
    current: str | None = None
    for raw in text.splitlines():
        line = raw.strip()
        match = SECTION.match(line)
        if match:
            current = match.group(1).lower()
            continue
        if current and line.lower().startswith("state"):
            if line[len("state") :].strip(" :\t").lower() == "on":
                found.add(current)
    return frozenset(found)


def blocks_inbound(text: str) -> bool:
    """Whether the active profile's policy still drops unsolicited packets."""
    for raw in text.splitlines():
        line = raw.strip()
        if line.lower().startswith("firewall policy"):
            value = line[len("firewall policy") :].strip(" :\t").lower()
            return "blockinbound" in value
    return True


def _same_program(value: str, program: str) -> bool:
    if not program:
        return False
    if value.strip().lower() in {"", "any"}:
        return True
    return os.path.normcase(value.strip()) == os.path.normcase(program)


def _covers(ports: str, port: int) -> bool:
    value = ports.strip().lower()
    if not value or value == "any":
        return True
    for part in value.split(","):
        chunk = part.strip()
        low, _, high = chunk.partition("-")
        if high and low.strip().isdigit() and high.strip().isdigit():
            if int(low) <= port <= int(high):
                return True
        elif chunk.isdigit() and int(chunk) == port:
            return True
    return False


def diagnose(
    port: int,
    program: str,
    profiles: Iterable[str],
    rules: Sequence[Rule],
    inbound_blocked: bool = True,
) -> str | None:
    """One sentence for the server window, or None when the door is open."""
    active = {name.lower() for name in profiles}
    if not active:
        return None  # the firewall is off on every profile

    for rule in rules:
        if not (rule.enabled and rule.inbound and rule.action == "block"):
            continue
        if _same_program(rule.program, program) and (rule.profiles & active):
            where = ", ".join(sorted(rule.profiles & active))
            return (
                f'Windows Firewall is dropping the iPad: the inbound rule "{rule.name}" blocks '
                f"{os.path.basename(program)} on the {where} network profile, and a block rule wins "
                "over every allow rule. Run scripts\\allow-firewall.ps1 in an Administrator window."
            )

    if not inbound_blocked:
        return None

    for rule in rules:
        if not (rule.enabled and rule.inbound and rule.action == "allow"):
            continue
        if not (rule.profiles & active):
            continue
        if _same_program(rule.program, program) and _covers(rule.port, port):
            return None

    where = ", ".join(sorted(active))
    return (
        f"Windows Firewall has no inbound rule for TCP {port} on the {where} network profile, so the "
        "iPad's connection is dropped before it reaches this window. "
        "Run scripts\\allow-firewall.ps1 in an Administrator window."
    )


def _netsh(args: Sequence[str]) -> str:
    flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
    finished = subprocess.run(
        ["netsh", *args],
        capture_output=True,
        text=True,
        errors="replace",
        timeout=8,
        creationflags=flags,
    )
    return finished.stdout or ""


def check(port: int = 8443, program: str | None = None) -> str | None:
    """The warning to print at startup, or None. Never raises."""
    if os.name != "nt":
        return None
    executable = program or sys.executable
    try:
        current = _netsh(["advfirewall", "show", "currentprofile"])
        rules_text = _netsh(["advfirewall", "firewall", "show", "rule", "name=all", "dir=in", "verbose"])
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    if not rules_text:
        return None
    return diagnose(
        port,
        executable,
        active_profiles(current),
        parse_rules(rules_text),
        blocks_inbound(current),
    )
