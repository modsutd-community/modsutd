"""One-time interactive login for the THROWAWAY account.

Run locally, never in CI:

    pip install telethon
    TG_API_ID=... TG_API_HASH=... python3 tools/telegram/login.py

Prints a StringSession - paste it into the TG_SESSION Actions secret.
The session is full account access: throwaway account only.

Needs raw MTProto egress, which many corporate/campus networks block
while still allowing telegram.org over HTTPS (symptom: "Connection reset
by peer" during auth_key gen). Easiest fix is a phone hotspot; otherwise
set TG_PROXY=socks5://host:port (pip install "python-socks[asyncio]") or
TG_MTPROXY=host:port:secret.
"""

from __future__ import annotations

import os
import sys
from urllib.parse import urlparse

from telethon.sessions import StringSession
from telethon.sync import TelegramClient


def connection_kwargs() -> dict:
    mt = os.environ.get("TG_MTPROXY")
    if mt:
        from telethon.network import ConnectionTcpMTProxyRandomizedIntermediate

        host, port, secret = mt.rsplit(":", 2)
        return {
            "connection": ConnectionTcpMTProxyRandomizedIntermediate,
            "proxy": (host, int(port), secret),
        }

    url = os.environ.get("TG_PROXY")
    if url:
        p = urlparse(url if "://" in url else f"socks5://{url}")
        if not p.hostname or not p.port:
            sys.exit("TG_PROXY must look like socks5://host:port")
        proxy = {"proxy_type": p.scheme, "addr": p.hostname, "port": p.port, "rdns": True}
        if p.username:
            proxy["username"] = p.username
            proxy["password"] = p.password or ""
        return {"proxy": proxy}

    return {}


def main() -> int:
    try:
        api_id = int(os.environ["TG_API_ID"])
        api_hash = os.environ["TG_API_HASH"]
    except KeyError as missing:
        sys.exit(f"set {missing} first (my.telegram.org -> API development tools)")

    try:
        with TelegramClient(StringSession(), api_id, api_hash, **connection_kwargs()) as client:
            me = client.get_me()
            print(f"\nlogged in as {me.first_name} (@{me.username or 'no username'})")
            print("\nTG_SESSION:\n")
            print(client.session.save())
            print(
                "\nnext, from any machine:\n"
                "  gh secret set TG_SESSION --repo modsutd-community/modsutd\n"
                "(or paste it into Settings -> Secrets and variables -> Actions)\n"
                "Treat it like a password: it is full access to this account.\n"
            )
    except ConnectionError as exc:
        sys.exit(
            f"\ncannot reach Telegram's servers: {exc}\n\n"
            "The handshake was reset, which usually means this network allows\n"
            "telegram.org over HTTPS but blocks raw MTProto. Try, in order:\n"
            "  1. a phone hotspot - this is a one-time step, the session string\n"
            "     works anywhere afterwards and GitHub Actions is unfiltered;\n"
            '  2. TG_PROXY=socks5://host:port  (pip install "python-socks[asyncio]");\n'
            "  3. TG_MTPROXY=host:port:secret  (an MTProxy from a public list).\n"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
