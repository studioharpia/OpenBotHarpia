#!/usr/bin/env python3
"""Copies only this project's ACME identity on the same host; never prints certificate keys."""
import base64
import json
import os
from pathlib import Path
import ssl
import tempfile

DOMAIN = 'openbot.harpia.digital'
SOURCE = Path('/etc/dokploy/traefik/dynamic/acme.json')
TARGET = Path('/opt/openbot/state/tls')

def main():
    data = json.loads(SOURCE.read_text())
    entries = [item for resolver in data.values() if isinstance(resolver, dict)
               for item in resolver.get('Certificates', [])
               if item.get('domain', {}).get('main') == DOMAIN]
    if len(entries) != 1:
        raise RuntimeError('A unique certificate for this project is required.')
    chain = base64.b64decode(entries[0]['certificate'], validate=True)
    private = base64.b64decode(entries[0]['key'], validate=True)
    TARGET.mkdir(parents=True, exist_ok=True)
    os.chown(TARGET, 0, 2000)
    os.chmod(TARGET, 0o750)
    if all((TARGET/name).exists() and (TARGET/name).read_bytes() == value
           for name, value in [('fullchain.pem', chain), ('privkey.pem', private)]):
        return
    with tempfile.TemporaryDirectory(prefix='.renew-', dir=TARGET) as temporary:
        cert = Path(temporary)/'fullchain.pem'
        key = Path(temporary)/'privkey.pem'
        cert.write_bytes(chain)
        key.write_bytes(private)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        for path in [key, cert]:
            os.chown(path, 0, 2000)
            os.chmod(path, 0o640)
            os.replace(path, TARGET/path.name)
    print(json.dumps({'project': 'OpenBot', 'certificateUpdated': True}))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'project': 'OpenBot', 'certificateSyncFailed': True, 'type': type(error).__name__}))
        raise SystemExit(1)
