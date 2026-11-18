"""What iOS will accept, asserted on the certificate actually served.

The iPad is the only client, and nobody can read its screen from here: these
tests are the only way to check the rules Apple documents, against the very
bytes Uvicorn presents on the LAN, and against the root the profile installs.
"""

import datetime as dt
import hashlib

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from app import certs
from app.config import Settings, host_name, local_ip


@pytest.fixture
def cfg(tmp_path, monkeypatch) -> Settings:
    monkeypatch.setenv("THOTH_DATA_DIR", str(tmp_path))
    return Settings().load()


def _served_chain(cfg: Settings) -> list[x509.Certificate]:
    certs.ensure_certificates(cfg)
    return x509.load_pem_x509_certificates(cfg.cert_file.read_bytes())


def _verify_against_root(leaf: x509.Certificate, root: x509.Certificate) -> None:
    key = root.public_key()
    algorithm = leaf.signature_hash_algorithm
    if isinstance(key, ec.EllipticCurvePublicKey):
        key.verify(leaf.signature, leaf.tbs_certificate_bytes, ec.ECDSA(algorithm))
    else:
        key.verify(leaf.signature, leaf.tbs_certificate_bytes, padding.PKCS1v15(), algorithm)


def test_the_served_certificate_meets_every_apple_requirement(cfg):
    chain = _served_chain(cfg)
    leaf, root = chain[0], chain[-1]
    now = dt.datetime.now(dt.timezone.utc)

    # Apple refuses a lifetime above 398 days (and drops the app on 825).
    span = leaf.not_valid_after_utc - leaf.not_valid_before_utc
    assert span <= dt.timedelta(days=398), f"lifetime {span} exceeds Apple's 398 days"
    assert leaf.not_valid_before_utc <= now < leaf.not_valid_after_utc, "the leaf must be valid right now"

    # The purpose must be TLS server authentication, and only that.
    eku = leaf.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    assert ExtendedKeyUsageOID.SERVER_AUTH in eku
    assert ExtendedKeyUsageOID.CLIENT_AUTH not in eku

    # The iPad dials the current LAN address; both it and the name must be on it.
    san = leaf.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    names = {str(v).lower() for v in san.get_values_for_type(x509.DNSName)}
    addresses = {str(v) for v in san.get_values_for_type(x509.IPAddress)}
    assert local_ip() in addresses, f"the address the QR carries is missing: {sorted(addresses)}"
    assert host_name().lower() in names, f"the laptop name is missing: {sorted(names)}"

    # A server certificate is not an authority.
    constraints = leaf.extensions.get_extension_for_class(x509.BasicConstraints).value
    assert constraints.ca is False

    # Modern key and signature.
    key = leaf.public_key()
    if isinstance(key, rsa.RSAPublicKey):
        assert key.key_size >= 2048, key.key_size
    else:
        assert isinstance(key, ec.EllipticCurvePublicKey)
        assert key.key_size >= 256, key.key_size
    assert leaf.signature_hash_algorithm.name == "sha256"
    assert root.signature_hash_algorithm.name == "sha256"

    # One chain, ending at exactly the certificate the .mobileconfig installs.
    assert len(chain) == 2, "the server must present the leaf plus its root"
    assert root.fingerprint(hashes.SHA256()) == hashlib.sha256(cfg.ca_file.read_bytes()).digest()
    assert leaf.issuer == root.subject
    _verify_against_root(leaf, root)


def test_a_longer_lifetime_setting_is_clamped_to_apples_limit(cfg):
    cfg.leaf_valid_days = 900
    leaf = _served_chain(cfg)[0]
    span = leaf.not_valid_after_utc - leaf.not_valid_before_utc
    assert span <= dt.timedelta(days=398), "a config value must never break what iOS accepts"


def test_the_root_is_a_real_authority_with_a_sha256_signature(cfg):
    certs.ensure_certificates(cfg)
    root = x509.load_der_x509_certificate(cfg.ca_file.read_bytes())
    constraints = root.extensions.get_extension_for_class(x509.BasicConstraints).value
    assert constraints.ca is True
    assert root.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value == certs.CA_COMMON_NAME
    assert root.signature_hash_algorithm.name == "sha256"


def test_a_changed_address_is_reported_instead_of_failing_silently(cfg):
    certs.ensure_certificates(cfg)
    assert certs.missing_coverage(cfg) is None
    message = certs.missing_coverage(cfg, address="10.9.8.7")
    assert message and "10.9.8.7" in message
    assert "run.bat" in message, "the reader needs the one action that fixes it"
