from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    service_auth_token: str = ""
    environment: str = "development"

    llm_provider: str = "mock"
    llm_model: str = "gpt-4o-mini"
    llm_timeout_seconds: float = 30.0
    llm_max_retries: int = 3
    llm_max_input_tokens: int = 12000
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    gemini_api_key: str = ""
    gemini_model: str = "gemini-1.5-flash"

    embedding_provider: str = "hash"
    embedding_model: str = "text-embedding-3-small"
    embedding_dim: int = 256

    vector_store: str = "memory"
    mongodb_uri: str = ""
    mongodb_db: str = "trustmark"

    cost_per_1k_input: float = 0.0
    cost_per_1k_output: float = 0.0

    max_content_chars: int = 200000


@lru_cache
def get_settings() -> Settings:
    return Settings()
