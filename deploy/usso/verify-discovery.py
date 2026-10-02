"""Verify the dedicated provider using public HTTPS metadata; prints no secrets."""
import json
import ssl
import sys
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

ISSUER = "https://login.jiarui.academy/application/o/mentor-portal/"
phase = "fetch_discovery"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def require(condition):
    if not condition:
        raise RuntimeError("The public provider metadata did not match the reviewed configuration.")


def get_json(url):
    opener = build_opener(NoRedirect, HTTPSHandler(context=ssl.create_default_context()))
    with opener.open(Request(url, headers={"Accept": "application/json", "User-Agent": "Mentor-Portal-OIDC-Verification/1.0"}), timeout=15) as response:
        if response.status != 200:
            raise RuntimeError("Discovery HTTP status is not successful.")
        payload = response.read(256 * 1024 + 1)
        if len(payload) > 256 * 1024:
            raise RuntimeError("Discovery response is too large.")
        return json.loads(payload)


try:
    metadata = get_json(ISSUER + ".well-known/openid-configuration")
    phase = "issuer"
    require(metadata["issuer"] == ISSUER)
    phase = "pkce"
    require("S256" in metadata["code_challenge_methods_supported"])
    phase = "signing_algorithm"
    require("RS256" in metadata["id_token_signing_alg_values_supported"])
    phase = "client_authentication"
    require("client_secret_basic" in metadata["token_endpoint_auth_methods_supported"])
    phase = "response_type"
    require("code" in metadata["response_types_supported"])
    phase = "scopes"
    require(set(metadata.get("scopes_supported", [])) == {"openid", "profile", "email"})
    phase = "endpoint_origins"
    endpoints = {field: metadata[field] for field in ("authorization_endpoint", "token_endpoint", "jwks_uri")}
    for endpoint in endpoints.values():
        parsed = urlsplit(endpoint)
        require(parsed.scheme == "https" and parsed.netloc == urlsplit(ISSUER).netloc and not parsed.username and not parsed.password and not parsed.fragment)
    phase = "fetch_jwks"
    jwks = get_json(endpoints["jwks_uri"])
    phase = "rsa_jwks"
    rsa_keys = [key for key in jwks["keys"] if key.get("kty") == "RSA" and key.get("alg", "RS256") == "RS256" and key.get("use", "sig") == "sig" and isinstance(key.get("n"), str) and isinstance(key.get("e"), str) and not any(field in key for field in ("d", "p", "q", "dp", "dq", "qi"))]
    require(bool(rsa_keys))
    print(json.dumps({"event": "mentor_usso_discovery_verified", "issuer": metadata["issuer"], "pkce_s256": True, "rs256": True, "client_secret_basic": True, "scopes": metadata["scopes_supported"], "endpoints": endpoints, "rsa_signing_key_count": len(rsa_keys), "grant_types_supported": metadata.get("grant_types_supported"), "tls_verification": "system-trust-and-hostname", "redirects_followed": False}))
except Exception as error:
    print(json.dumps({"event": "mentor_usso_discovery_error", "code": "DISCOVERY_OR_JWKS_VERIFICATION_FAILED", "phase": phase, "error_class": type(error).__name__, "reason_class": type(getattr(error, "reason", None)).__name__, "http_status": getattr(error, "code", None)}))
    sys.exit(1)
