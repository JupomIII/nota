"""The two firewall facts that decide whether the iPad can connect."""

from app.netcheck import (
    Rule,
    active_profiles,
    blocks_inbound,
    diagnose,
    parse_rules,
)

CURRENT = """
Public Profile Settings:
----------------------------------------------------------------------
State                                 ON
Firewall Policy                       BlockInbound,AllowOutbound
LocalFirewallRules                    N/A (GPO-store only)

Private Profile Settings:
----------------------------------------------------------------------
State                                 OFF
Firewall Policy                       BlockInbound,AllowOutbound
"""

LISTING = """
----------------------------------------------------------------------
Rule Name:                            python.exe
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Public
LocalPort:                            Any
Program:                              C:\\Users\\dev\\AppData\\Local\\Programs\\Python\\Python314\\python.exe
Action:                               Block
----------------------------------------------------------------------
Rule Name:                            Thoth Notes
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Private,Public
LocalPort:                            8443
Program:                              Any
Action:                               Allow
"""

SERVER = "C:\\Users\\dev\\AppData\\Local\\Programs\\Python\\Python314\\python.exe"


def test_reads_the_profiles_that_are_actually_on():
    assert active_profiles(CURRENT) == frozenset({"public"})
    assert blocks_inbound(CURRENT) is True


def test_reads_the_rules_and_their_scope():
    rules = parse_rules(LISTING)
    assert [(rule.name, rule.action, rule.enabled) for rule in rules] == [
        ("python.exe", "block", True),
        ("Thoth Notes", "allow", True),
    ]
    assert rules[0].profiles == frozenset({"public"})
    assert rules[1].profiles == frozenset({"private", "public"})
    assert rules[1].port == "8443"


def test_names_the_block_rule_that_wins_over_the_allow_rule():
    message = diagnose(8443, SERVER, active_profiles(CURRENT), parse_rules(LISTING))
    assert message is not None
    assert "python.exe" in message
    assert "public" in message
    assert "allow-firewall.ps1" in message


def test_says_nothing_once_the_block_rule_is_gone():
    rules = [rule for rule in parse_rules(LISTING) if rule.action == "allow"]
    assert diagnose(8443, SERVER, {"public"}, rules) is None


def test_warns_when_only_a_private_rule_exists_on_a_public_network():
    rules = [rule for rule in parse_rules(LISTING) if rule.action == "allow"]
    private_only = [Rule(**{**rule.__dict__, "profiles": frozenset({"private"})}) for rule in rules]
    message = diagnose(8443, SERVER, {"public"}, private_only)
    assert message is not None
    assert "TCP 8443" in message


def test_accepts_a_rule_for_any_program_and_any_port():
    rules = [
        Rule(
            name="Everything",
            enabled=True,
            inbound=True,
            profiles=frozenset({"public"}),
            action="allow",
            program="Any",
            port="Any",
        )
    ]
    assert diagnose(8443, SERVER, {"public"}, rules) is None


def test_stays_quiet_when_the_firewall_is_off():
    assert active_profiles("Public Profile Settings:\nState OFF\n") == frozenset()
    assert diagnose(8443, SERVER, set(), parse_rules(LISTING)) is None


def test_stays_quiet_when_inbound_is_allowed_by_policy():
    rules = [rule for rule in parse_rules(LISTING) if rule.action == "allow"]
    listing = [Rule(**{**rule.__dict__, "profiles": frozenset({"private"})}) for rule in rules]
    assert diagnose(8443, SERVER, {"public"}, listing, inbound_blocked=False) is None


def test_ignores_a_block_rule_for_another_program():
    other = [Rule(**{**rule.__dict__, "program": "C:\\\\other\\\\tool.exe"}) for rule in parse_rules(LISTING)[:1]]
    allow = [rule for rule in parse_rules(LISTING) if rule.action == "allow"]
    assert diagnose(8443, SERVER, {"public"}, [*other, *allow]) is None
