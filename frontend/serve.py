#!/usr/bin/env python3
"""Local dev server for the signing page.

Serves on 127.0.0.1, which browsers treat as a secure origin - crypto.subtle
and the geolocation prompt both need that, so file:// will not do.

    python serve.py            then open the printed URL
"""
import http.server
import re
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',   # modules need a JS mime type or they will not load
        '.mjs': 'text/javascript',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        # Production serves the page at /s/<token>; mirror that locally so the
        # token parsing in api.js is exercised on the real path shape.
        # Only the token path itself maps to the app - never a nested asset
        # request, which must 404 loudly rather than quietly return HTML and
        # surface as a baffling "Unexpected token '<'" in the console.
        if re.fullmatch(r'/s/[^/]*', self.path.split('?')[0]):
            self.path = '/index.html'
        return super().do_GET()

    def log_message(self, fmt, *args):
        sys.stderr.write('  %s\n' % (fmt % args))


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
    base = f'http://127.0.0.1:{PORT}'
    print(f'Signing page on {base}\n')
    print('Scenarios:')
    for s, label in [
        ('turn', 'your turn, one earlier signature'),
        ('first', 'signer 1 of 3, nothing signed yet'),
        ('last', 'final signer; submitting completes it'),
        ('notyour', 'not your turn, names who we wait on'),
        ('refused', 'expired or already used'),
    ]:
        print(f'  {label:<38} {base}/index.html?mock=1&scenario={s}')
    print('\nCtrl+C to stop.')
    httpd.serve_forever()
