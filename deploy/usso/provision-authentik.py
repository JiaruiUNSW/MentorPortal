"""Run only through Authentik 2026.5.3's `ak shell`, as container root.

Creates only the dedicated Mentor Portal application/provider. Credentials never
leave the private JSON file through stdout, stderr, command arguments or logs.
"""

import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import stat
from datetime import datetime, timezone

from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import Encoding, load_pem_private_key
from django.db import connection, transaction
from django.db.models import Q

from authentik.core.models import Application
from authentik.crypto.models import CertificateKeyPair
from authentik.flows.models import Flow
from authentik.providers.oauth2.models import OAuth2Provider, ScopeMapping


SLUG = "mentor-portal"
NAME = "Mentor Portal"
ISSUER = "https://login.jiarui.academy/application/o/mentor-portal/"
CALLBACK = "https://mentor-portal.com/api/auth/usso/callback"
LAUNCH_URL = "https://mentor-portal.com/login"
KEY_ID = "35403c72-9006-4f5e-969c-d3692862d478"
PRIVATE_DIR = Path("/run/mentor-portal-usso")
CREDENTIALS = PRIVATE_DIR / "client-credentials.json"
OWNER = "mentor-portal-usso-v1"
PHASE = "initialization"
REDIRECTS = [{"matching_mode": "strict", "url": CALLBACK, "redirect_uri_type": "authorization"}]
FLOW_SLUGS = {
    "authentication_flow": "default-authentication-flow",
    "authorization_flow": "default-provider-authorization-explicit-consent",
    "invalidation_flow": "default-provider-invalidation-flow",
}


def require(condition):
    if not condition:
        raise RuntimeError("The dedicated provider precondition was not satisfied.")


def read_private():
    try:
        descriptor = os.open(CREDENTIALS, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600 and info.st_uid == 0 and info.st_nlink == 1)
        saved = json.load(handle)
    require(saved.get("owner") == OWNER and saved.get("application_slug") == SLUG and saved.get("issuer") == ISSUER and saved.get("callback_uri") == CALLBACK)
    return saved


def write_private(saved):
    temporary = PRIVATE_DIR / (".credentials-" + secrets.token_hex(16))
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(saved, handle, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        # An existing private record is never overwritten or rotated by this script.
        os.link(temporary, CREDENTIALS, follow_symlinks=False)
        temporary.unlink()
        parent = os.open(PRIVATE_DIR, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        temporary.unlink(missing_ok=True)


def public_provider(provider, application, key, certificate, action):
    return {
        "event": "mentor_usso_provider_status",
        "action": action,
        "application_slug": application.slug,
        "application_id": str(application.pk),
        "provider_id": provider.pk,
        "provider_name": provider.name,
        "client_type": provider.client_type,
        "grant_types": provider.grant_types,
        "redirect_uris": provider._redirect_uris,
        "issuer": ISSUER,
        "issuer_mode": provider.issuer_mode,
        "subject_mode": provider.sub_mode,
        "scope_mappings": sorted(ScopeMapping.objects.filter(pk__in=provider.property_mappings.values_list("pk", flat=True)).values_list("scope_name", flat=True)),
        "flow_slugs": FLOW_SLUGS,
        "signing_key_id": str(key.pk),
        "signing_key_rsa_bits": certificate.public_key().key_size,
        "signing_certificate_sha256": hashlib.sha256(certificate.public_bytes(Encoding.DER)).hexdigest(),
        "signing_certificate_valid_until": certificate.not_valid_after_utc.isoformat(),
        "application_hidden": application.meta_hide,
        "credentials_written_privately": True,
        "verified_at": datetime.now(timezone.utc).isoformat(),
    }


def main():
    global PHASE
    PHASE = "private_directory"
    require(os.geteuid() == 0)
    PRIVATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = PRIVATE_DIR.lstat()
    require(stat.S_ISDIR(info.st_mode) and not PRIVATE_DIR.is_symlink() and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700)
    PHASE = "signing_key"
    key = CertificateKeyPair.objects.get(pk=KEY_ID)
    certificate = x509.load_pem_x509_certificate(key.certificate_data.encode())
    private_key = load_pem_private_key(key.key_data.encode(), password=None)
    require(isinstance(certificate.public_key(), rsa.RSAPublicKey) and isinstance(private_key, rsa.RSAPrivateKey))
    require(certificate.public_key().key_size >= 2048 and certificate.public_key().public_numbers() == private_key.public_key().public_numbers())
    require(certificate.not_valid_before_utc <= datetime.now(timezone.utc) < certificate.not_valid_after_utc)
    PHASE = "flows_and_scopes"
    flows = {field: Flow.objects.get(slug=slug) for field, slug in FLOW_SLUGS.items()}
    require(flows["authentication_flow"].designation == "authentication" and flows["authorization_flow"].designation == "authorization" and flows["invalidation_flow"].designation == "invalidation")
    scopes = [ScopeMapping.objects.get(managed="goauthentik.io/providers/oauth2/scope-" + name, scope_name=name) for name in ("openid", "profile", "email")]
    expected = {
        "name": NAME,
        "client_type": "confidential",
        "grant_types": ["authorization_code"],
        "_redirect_uris": REDIRECTS,
        "issuer_mode": "per_provider",
        "sub_mode": "user_uuid",
        "signing_key_id": key.pk,
        "encryption_key_id": None,
        "include_claims_in_id_token": True,
        "access_code_validity": "minutes=1",
        "access_token_validity": "minutes=5",
        **{field + "_id": value.pk for field, value in flows.items()},
    }
    with transaction.atomic():
        PHASE = "transaction_lock"
        # Serialize only this provisioning operation; no global/user/LDAP setting is changed.
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(%s)", [int(hashlib.sha256(OWNER.encode()).hexdigest()[:15], 16)])
        saved = read_private()
        apps = list(Application.objects.filter(Q(slug=SLUG) | Q(name__iexact=NAME)))
        providers = list(OAuth2Provider.objects.filter(name__iexact=NAME))
        if apps or providers or saved:
            PHASE = "existing_object_verification"
            require(saved is not None and len(apps) == 1 and len(providers) == 1)
            application, provider = apps[0], providers[0]
            require(application.provider_id == provider.pk and saved.get("provider_id") == provider.pk and saved.get("application_id") == str(application.pk))
            require(all(getattr(provider, field) == value for field, value in expected.items()))
            require(set(provider.property_mappings.values_list("pk", flat=True)) == {scope.pk for scope in scopes})
            require(application.name == NAME and application.slug == SLUG and application.meta_launch_url == LAUNCH_URL and application.meta_hide is True)
            require(hmac.compare_digest(provider.client_id, saved.get("client_id", "")) and hmac.compare_digest(provider.client_secret, saved.get("client_secret", "")))
            action = "verified_existing"
        else:
            PHASE = "provider_validation"
            provider = OAuth2Provider(**expected, client_id=secrets.token_urlsafe(32), client_secret=secrets.token_urlsafe(64))
            # Authentik's nullable optional keys have blank=False on this release;
            # an ordinary non-backchannel, unencrypted OIDC provider leaves both unset.
            for field in ("backchannel_application", "encryption_key"):
                require(OAuth2Provider._meta.get_field(field).null is True and getattr(provider, field) is None)
            provider.full_clean(exclude=("backchannel_application", "encryption_key"))
            provider.save()
            provider.property_mappings.set(scopes)
            PHASE = "application_validation"
            application = Application(name=NAME, slug=SLUG, provider=provider, meta_launch_url=LAUNCH_URL, meta_description="Mentor Portal account sign-in. Portal access requires an existing explicitly linked account.", meta_publisher="Mentor Portal", meta_hide=True, policy_engine_mode="all")
            application.full_clean()
            application.save()
            PHASE = "credential_write"
            write_private({
                "owner": OWNER, "application_slug": SLUG, "application_id": str(application.pk), "provider_name": NAME, "provider_id": provider.pk,
                "issuer": ISSUER, "callback_uri": CALLBACK, "client_id": provider.client_id, "client_secret": provider.client_secret,
                "created_at": datetime.now(timezone.utc).isoformat(),
            })
            action = "created"
    PHASE = "public_readback"
    print(json.dumps(public_provider(provider, application, key, certificate, action), default=str))


try:
    main()
except Exception as error:
    # Do not expose validation values, private JSON, secrets or raw ORM errors.
    print(json.dumps({"event": "mentor_usso_provider_error", "code": "PROVISIONING_REFUSED_OR_FAILED", "phase": PHASE, "error_class": type(error).__name__, "validation_fields": sorted(getattr(error, "error_dict", {}).keys())}))
    raise SystemExit(1)
