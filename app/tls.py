"""Self-signed certificate for the web UI when no certificate is mounted."""
import datetime
import ipaddress
import logging
import socket
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

log = logging.getLogger("hmcscan")


def ensure_certificate(tls_dir: Path) -> tuple[Path, Path]:
    """Return (cert, key). Uses /data/tls/cert.pem + key.pem if present, otherwise creates them."""
    tls_dir.mkdir(parents=True, exist_ok=True)
    cert, key = tls_dir / "cert.pem", tls_dir / "key.pem"
    if cert.exists() and key.exists():
        return cert, key
    host = socket.gethostname()
    pk = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "HMCscan"),
                      x509.NameAttribute(NameOID.ORGANIZATION_NAME, "HMCscan self-signed")])
    now = datetime.datetime.now(datetime.timezone.utc)
    crt = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name).public_key(pk.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName([
            x509.DNSName(host), x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(pk, hashes.SHA256())
    )
    key.write_bytes(pk.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                     serialization.NoEncryption()))
    key.chmod(0o600)
    cert.write_bytes(crt.public_bytes(serialization.Encoding.PEM))
    log.warning("Создан самоподписанный сертификат %s. Чтобы использовать свой, положите cert.pem и key.pem в %s.", cert, tls_dir)
    return cert, key
