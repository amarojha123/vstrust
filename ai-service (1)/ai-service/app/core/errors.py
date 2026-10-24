class ProviderError(Exception):
    """Base class for LLM provider failures."""
    retryable = False


class RateLimitError(ProviderError):
    retryable = True


class ProviderTimeout(ProviderError):
    retryable = True


class ProviderUnavailable(ProviderError):
    retryable = True


class InvalidModelResponse(ProviderError):
    retryable = False


class TokenLimitExceeded(ProviderError):
    retryable = False


class TenantViolation(Exception):
    """Raised when data from another organization is encountered."""
