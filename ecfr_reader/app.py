"""The Flask app: the API blueprint plus the reader's static files.
`ecfr-reader serve` runs it on Flask's development server; for anything
shared, point a WSGI server at `ecfr_reader.app:create_app()`."""
import os

from flask import Flask, send_from_directory

from . import config
from .annotations import init_db
from .api import bp

STATIC = os.path.join(os.path.dirname(__file__), "static")


def create_app():
    app = Flask(__name__, static_folder=STATIC, static_url_path="")
    app.register_blueprint(bp)
    os.makedirs(os.path.dirname(os.path.abspath(config.annotations_db())), exist_ok=True)
    init_db()

    @app.route("/")
    def index():
        return send_from_directory(STATIC, "index.html")

    return app
