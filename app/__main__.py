"""Entry point: python -m app

Runs two web servers in one process: the read-only viewer on HMCSCAN_PORT and
the administration interface on HMCSCAN_ADMIN_PORT. Both share one database and
one HMC poller.
"""
import asyncio
import contextlib
import logging
import signal

import uvicorn

from . import config
from .main import Context, create_app
from .tls import ensure_certificate

log = logging.getLogger("hmcscan")


class _Server(uvicorn.Server):
    # Signals are handled once for both servers in serve() below.
    @contextlib.contextmanager
    def capture_signals(self):
        yield


async def serve() -> None:
    ctx = Context(config.DATA_DIR)
    ssl_args = {}
    if config.TLS:
        cert, key = ensure_certificate(config.DATA_DIR / "tls")
        ssl_args = {"ssl_certfile": str(cert), "ssl_keyfile": str(key)}
    servers = [
        _Server(uvicorn.Config(create_app(ctx, "public"), host="0.0.0.0", port=config.PORT, log_level="info", **ssl_args)),
        _Server(uvicorn.Config(create_app(ctx, "admin"), host=config.ADMIN_BIND, port=config.ADMIN_PORT, log_level="info", **ssl_args)),
    ]
    loop = asyncio.get_running_loop()

    def stop() -> None:
        for s in servers:
            s.should_exit = True

    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop)
    scheme = "https" if config.TLS else "http"
    log.info("Просмотр: %s://<хост>:%d   Администрирование: %s://<хост>:%d", scheme, config.PORT, scheme, config.ADMIN_PORT)
    ctx.poller.start()
    try:
        await asyncio.gather(*(s.serve() for s in servers))
    finally:
        await ctx.poller.stop()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    asyncio.run(serve())


if __name__ == "__main__":
    main()
