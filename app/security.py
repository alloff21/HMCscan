"""Password hashing, secret storage and encryption of HMC credentials."""
import base64
import hashlib
import hmac
import logging
import os
import secrets
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

log = logging.getLogger("hmcscan")


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, salt_hex, digest_hex = stored.split("$")
    except ValueError:
        return False
    if algo != "scrypt":
        return False
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1, dklen=32)
    return hmac.compare_digest(digest.hex(), digest_hex)


def load_secret(data_dir: Path, from_env: str) -> str:
    """Use HMCSCAN_SECRET_KEY if given, otherwise a key generated once into the data volume."""
    if from_env:
        return from_env
    path = data_dir / "secret.key"
    if path.exists():
        return path.read_text().strip()
    key = secrets.token_urlsafe(48)
    path.write_text(key)
    path.chmod(0o600)
    log.warning("HMCSCAN_SECRET_KEY не задан: сгенерирован ключ %s. Сохраните том /data, иначе пароли HMC не расшифровать.", path)
    return key


class Vault:
    """Symmetric encryption (Fernet: AES-128-CBC + HMAC-SHA256) for stored passwords."""

    def __init__(self, secret: str):
        key = base64.urlsafe_b64encode(hashlib.sha256(("hmcscan-vault:" + secret).encode()).digest())
        self._f = Fernet(key)

    def encrypt(self, plain: str) -> str:
        return self._f.encrypt(plain.encode()).decode()

    def decrypt(self, token: str) -> str:
        try:
            return self._f.decrypt(token.encode()).decode()
        except InvalidToken as e:
            raise ValueError("Не удалось расшифровать пароль: изменился HMCSCAN_SECRET_KEY") from e
