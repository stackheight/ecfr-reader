"""The Flask app: the API blueprint plus the reader's static files.
`ecfr-reader serve` runs it on Flask's development server; for anything
shared, point a WSGI server at `ecfr_reader.app:create_app()`."""
import os

from flask import Flask, send_from_directory

from . import __version__, config
from .annotations import init_db
from .dockets.store import init_db as init_dockets_db
from .api import bp

STATIC = os.path.join(os.path.dirname(__file__), "static")


def create_app():
    app = Flask(__name__, static_folder=STATIC, static_url_path="")
    app.register_blueprint(bp)
    os.makedirs(os.path.dirname(os.path.abspath(config.annotations_db())), exist_ok=True)
    init_db()
    init_dockets_db()

    @app.route("/")
    def index():
        # The page's script and stylesheet links carry the version, so a
        # browser that cached the previous release's files fetches the new
        # ones after an upgrade instead of running stale code.
        with open(os.path.join(STATIC, "index.html"), encoding="utf-8") as f:
            return f.read().replace("{{v}}", __version__), 200, {"Content-Type": "text/html; charset=utf-8"}

    return app
