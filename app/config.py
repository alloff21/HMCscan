"""Runtime settings, read once from environment variables."""
import os
from pathlib import Path


def _flag(name: str, default: str) -> bool:
    return os.getenv(name, default).strip().lower() not in ("0", "false", "no", "off", "")


DATA_DIR = Path(os.getenv("HMCSCAN_DATA_DIR", "/data"))
PORT = int(os.getenv("HMCSCAN_PORT", "8843"))              # read-only viewer
ADMIN_PORT = int(os.getenv("HMCSCAN_ADMIN_PORT", "8844"))  # administration
# Address the admin interface listens on inside the container, e.g. 127.0.0.1 to keep it local.
ADMIN_BIND = os.getenv("HMCSCAN_ADMIN_BIND", "0.0.0.0")
TLS = _flag("HMCSCAN_TLS", "1")
SECRET_KEY = os.getenv("HMCSCAN_SECRET_KEY", "")
ADMIN_PASSWORD = os.getenv("HMCSCAN_ADMIN_PASSWORD", "")
DEMO = _flag("HMCSCAN_DEMO", "0")
# How many HMCs are polled at the same time.
POLL_CONCURRENCY = int(os.getenv("HMCSCAN_POLL_CONCURRENCY", "4"))
SESSION_HOURS = int(os.getenv("HMCSCAN_SESSION_HOURS", "12"))
