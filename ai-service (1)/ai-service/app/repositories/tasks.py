"""In-memory task store. Tasks are bound to an organization; reads must match it."""
from __future__ import annotations

import uuid
from typing import Dict, Optional

from app.schemas import AnalysisResult, TaskResponse, TaskStatus


class TaskRepository:
    def __init__(self, max_items: int = 1000):
        self._tasks: Dict[str, TaskResponse] = {}
        self._max = max_items

    def create(self, organization_id: str) -> TaskResponse:
        if len(self._tasks) >= self._max:
            self._tasks.pop(next(iter(self._tasks)))
        t = TaskResponse(task_id=f"task_{uuid.uuid4().hex[:16]}", organization_id=organization_id,
                         status=TaskStatus.PENDING)
        self._tasks[t.task_id] = t
        return t

    def set_running(self, task_id: str) -> None:
        if task_id in self._tasks:
            self._tasks[task_id].status = TaskStatus.RUNNING

    def complete(self, task_id: str, result: AnalysisResult) -> None:
        t = self._tasks[task_id]
        t.status, t.result = TaskStatus.COMPLETED, result

    def fail(self, task_id: str, error: str) -> None:
        t = self._tasks[task_id]
        t.status, t.error = TaskStatus.FAILED, error

    def get(self, task_id: str, organization_id: str) -> Optional[TaskResponse]:
        t = self._tasks.get(task_id)
        # Wrong-organization lookups look identical to missing tasks.
        return t if t and t.organization_id == organization_id else None
