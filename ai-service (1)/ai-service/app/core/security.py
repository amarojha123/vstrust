"""Service-to-service authentication.

The AI service does NOT authenticate application users. It only verifies that
the caller is the trusted backend, via a shared secret in X-Service-Token.
"""
import hmac

from fastapi import Depends, Header, HTTPException, status

from app.config import Settings, get_settings


async def require_service_auth(
    x_service_token: str = Header(default=""),
    authorization: str = Header(default=""),
    settings: Settings = Depends(get_settings),
) -> None:
    expected = settings.service_auth_token
    if not expected:
        # Fail closed: an unconfigured service must not accept traffic.
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "service auth not configured")
    bearer = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    supplied = x_service_token or bearer
    if not hmac.compare_digest(supplied.encode(), expected.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid service token")
