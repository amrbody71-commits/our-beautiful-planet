"""Dev server that refuses to let the browser cache anything.

`python -m http.server` sends no cache headers at all, which lets Chrome
apply its own heuristic caching to ES modules — you edit a module, reload,
and the page silently runs the old code. That failure is invisible and
costs an hour every time. This sends no-store on everything instead.

    python serve.py [port]        # default 8777

Dev only — excluded from the deploy by .vercelignore.
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    def do_POST(self):
        """POST /_shot/<name>.png writes the body to shots/<name>.png.

        The browser cannot write files and this pane cannot composite a GL
        canvas into a screenshot, so the page renders, reads the pixels back
        itself, and posts the result here. Dev only.
        """
        if not self.path.startswith("/_shot/"):
            self.send_error(404)
            return
        rel = self.path[len("/_shot/"):]
        # allow one level of subdirectory, e.g. /_shot/plates/01.webm
        parts = [Path(x).name for x in rel.split("/") if x]
        name = parts[-1] if parts else "shot.png"
        out = Path(__file__).parent / "shots"
        if len(parts) > 1:
            out = out.parent / "reel" / parts[-2]
        out.mkdir(parents=True, exist_ok=True)
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        (out / name).write_bytes(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(f"wrote {name} ({len(body)} bytes)".encode())

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter: errors only
        if not args or str(args[1]).startswith(("2", "3")):
            return
        super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    handler = partial(NoCacheHandler, directory=str(Path(__file__).parent))
    print(f"serving {Path(__file__).parent} at http://127.0.0.1:{port}/  (no-store)")
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
