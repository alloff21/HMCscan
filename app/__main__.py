"""Entry point: python -m app"""
import logging

import uvicorn

from . import config
from .main import create_app
from .tls import ensure_certificate


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    ssl_args = {}
    if config.TLS:
        cert, key = ensure_certificate(config.DATA_DIR / "tls")
        ssl_args = {"ssl_certfile": str(cert), "ssl_keyfile": str(key)}
    uvicorn.run(create_app(), host="0.0.0.0", port=config.PORT, log_level="info", **ssl_args)


if __name__ == "__main__":
    main()
