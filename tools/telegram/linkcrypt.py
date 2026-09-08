"""Encrypt a batch-chat invite link for the public registry.

The registry is committed to a public repo, so the link cannot sit in it in
the clear. Only frontend/api/telegram-link.js holds the key, and it hands the
plaintext to signed-in students one request at a time.

Format: v1:<base64 nonce>:<base64 ciphertext+tag>, AES-256-GCM, which is what
node's createDecipheriv('aes-256-gcm', ...) reads on the other side.

    TG_LINK_KEY=$(openssl rand -base64 32) python3 -c \
      "from linkcrypt import encrypt; print(encrypt('https://t.me/+abc'))"
"""

from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _key() -> bytes:
    raw = os.environ.get("TG_LINK_KEY", "")
    if not raw:
        raise SystemExit(
            "TG_LINK_KEY is not set. Without it the invite link would be "
            "committed in the clear to a public repo - refusing.\n"
            "Generate one with: openssl rand -base64 32"
        )
    key = base64.b64decode(raw)
    if len(key) != 32:
        raise SystemExit(f"TG_LINK_KEY must decode to 32 bytes, got {len(key)}")
    return key


def encrypt(link: str) -> str:
    nonce = os.urandom(12)
    body = AESGCM(_key()).encrypt(nonce, link.encode(), None)
    return "v1:{}:{}".format(
        base64.b64encode(nonce).decode(),
        base64.b64encode(body).decode(),
    )


def decrypt(payload: str) -> str:
    version, nonce_b64, body_b64 = payload.split(":", 2)
    if version != "v1":
        raise ValueError(f"unknown ciphertext version {version!r}")
    return (
        AESGCM(_key())
        .decrypt(base64.b64decode(nonce_b64), base64.b64decode(body_b64), None)
        .decode()
    )
