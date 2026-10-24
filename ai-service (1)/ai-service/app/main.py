from __future__ import annotations

from typing import Optional

from fastapi import FastAPI

from app.api.routes import public, router
from app.config import Settings, get_settings
from app.core.container import Container, build_container


def create_app(settings: Optional[Settings] = None, container: Optional[Container] = None) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(title="TRUST MARK AI Service", version="1.0.0")
    app.state.container = container or build_container(settings)
    app.dependency_overrides[get_settings] = lambda: settings
    app.include_router(public)
    app.include_router(router)
    return app


app = create_app()
