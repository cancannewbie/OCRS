"""Stable image extraction envelopes, independent of downstream order review."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from ocrs.domain import Candidate


class RecognitionTask(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1"] = "1"
    task_id: str
    status: Literal["received", "recognizing", "succeeded", "failed"]
    version: int
    provider: str
    model_revision: int
    recognition_mode: Literal["demo", "external"]
    verified: Literal[False] = False
    review_status: str
    duplicate: bool = False
    result_url: str
    error_code: str | None
    created_at: str
    updated_at: str


class RecognitionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1"] = "1"
    task_id: str
    status: Literal["succeeded"] = "succeeded"
    verified: Literal[False] = False
    recognition_mode: Literal["demo", "external"]
    review_status: str
    result: Candidate


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: Any = None


class ErrorResponse(BaseModel):
    error: ErrorDetail
