"""Static file server for the Paris 18e path-flow demo.

The page is plain HTML/JS, but it fetches paths.geojson, so it must be served
over HTTP rather than opened as a file:// URL.

Run:  python serve.py      then open http://127.0.0.1:5173/
"""

from __future__ import annotations

import http.server
import socketserver
import webbrowser
from functools import partial
from pathlib import Path
from threading import Timer

# NOT 5060/5061: those are the SIP ports, which Firefox (and Chrome) block as
# "restricted" and refuse to load over http, regardless of what is listening.
# 5173 is outside every browser blocklist.
PORT = 5173
STATIC_DIR = Path(__file__).resolve().parent / "static"


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        # The dataset is regenerated during development; never let the browser
        # serve a stale copy.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        print(f"  {self.address_string()} - {fmt % args}", flush=True)


def main() -> None:
    if not (STATIC_DIR / "paths.geojson").is_file():
        print("! static/paths.geojson is missing - run: python build_data.py")
        print("  The page will load but show an error until it exists.\n")

    handler = partial(Handler, directory=str(STATIC_DIR))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), handler) as httpd:
        url = f"http://127.0.0.1:{PORT}/"
        print(f"Paris 18e path-flow demo -> {url}   (Ctrl+C to stop)")
        Timer(0.6, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
