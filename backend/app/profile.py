"""The trust profile the iPad installs, as a real configuration profile.

A bare ``.cer`` opened in Safari is handled as a *file*: it lands in Files, the
"Profile Downloaded" sheet never appears, and nothing is added to Certificate
Trust Settings — so the iPad keeps refusing the laptop's certificate while the
reader believes the certificate is installed. A ``.mobileconfig`` with a
root-certificate payload is the shape iOS installs: it opens Settings, lists the
CA under VPN & Device Management, and then appears in Certificate Trust
Settings like any other profile.
"""

from __future__ import annotations

import plistlib
import uuid

DISPLAY_NAME = "NŌTA Local CA"
PROFILE_ID = "com.thoth.notes.local-ca"


def build_profile(ca_der: bytes, display_name: str = DISPLAY_NAME) -> bytes:
    """A signed-by-nobody profile carrying the CA, ready to be installed."""
    payload = {
        "PayloadType": "Configuration",
        "PayloadVersion": 1,
        "PayloadIdentifier": PROFILE_ID,
        "PayloadUUID": str(uuid.uuid4()).upper(),
        "PayloadDisplayName": display_name,
        "PayloadOrganization": "NŌTA",
        "PayloadDescription": (
            "Lets this iPad trust the NŌTA server running on your own laptop. "
            "The certificate belongs to that machine and is never sent anywhere."
        ),
        "PayloadRemovalDisallowed": False,
        "PayloadContent": [
            {
                "PayloadType": "com.apple.security.root",
                "PayloadVersion": 1,
                "PayloadIdentifier": f"{PROFILE_ID}.root",
                "PayloadUUID": str(uuid.uuid4()).upper(),
                "PayloadDisplayName": display_name,
                "PayloadCertificateFileName": "thoth-rootCA.cer",
                "PayloadContent": ca_der,
            }
        ],
    }
    return plistlib.dumps(payload, fmt=plistlib.FMT_XML)
