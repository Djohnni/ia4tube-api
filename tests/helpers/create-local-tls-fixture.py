"""Generate ephemeral CA/leaf material for the local Node TLS test harness.

No files, network connections or trust-store changes are made. The Node helper
consumes stdout in memory and performs the same real loopback TLS handshakes.
"""

import datetime
import json
import re
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def certificate_builder(subject, issuer, public_key):
    now = datetime.datetime.now(datetime.timezone.utc)
    return (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(public_key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
    )


def certificate_pem(certificate):
    return certificate.public_bytes(serialization.Encoding.PEM).decode("ascii")


def create_ca(label):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"IA4Tube-Synthetic-CA-{label}")])
    certificate = (
        certificate_builder(name, name, key.public_key())
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False, content_commitment=False,
                key_encipherment=False, data_encipherment=False,
                key_agreement=False, key_cert_sign=True, crl_sign=True,
                encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .sign(key, hashes.SHA256())
    )
    return key, certificate


def create_leaf(ca_key, ca_certificate, hostname, include_san=True):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hostname)])
    builder = (
        certificate_builder(name, ca_certificate.subject, key.public_key())
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, content_commitment=False,
                key_encipherment=True, data_encipherment=False,
                key_agreement=False, key_cert_sign=False, crl_sign=False,
                encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
    )
    if include_san:
        builder = builder.add_extension(
            x509.SubjectAlternativeName([x509.DNSName(hostname)]), critical=False
        )
    return {
        "certificate": certificate_pem(builder.sign(ca_key, hashes.SHA256())),
        "key": key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("ascii"),
    }


def main():
    if len(sys.argv) != 3:
        raise ValueError("invalid fixture arguments")
    correct_hostname, wrong_hostname = sys.argv[1:]
    for hostname in (correct_hostname, wrong_hostname):
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,62}\.synthetic\.example", hostname):
            raise ValueError("fixture hostname must be synthetic")
    if correct_hostname == wrong_hostname:
        raise ValueError("fixture hostnames must differ")
    trusted_key, trusted_ca = create_ca("trusted")
    _, wrong_ca = create_ca("wrong")
    fixture = {
        "trustedCa": certificate_pem(trusted_ca),
        "wrongCa": certificate_pem(wrong_ca),
        "correctLeaf": create_leaf(trusted_key, trusted_ca, correct_hostname),
        "wrongHostnameLeaf": create_leaf(trusted_key, trusted_ca, wrong_hostname),
        "missingSanLeaf": create_leaf(trusted_key, trusted_ca, correct_hostname, include_san=False),
    }
    sys.stdout.write(json.dumps(fixture))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Do not emit certificate/key material or supplied arguments on failure.
        sys.stderr.write("synthetic_tls_certificate_generation_failed\n")
        sys.exit(1)
