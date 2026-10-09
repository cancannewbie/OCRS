"""Strict recognition contracts and pure, exact-money confirmation rules.

A Candidate is untrusted review material. Validating it never creates an order.
Decimal values serialize as strings; no binary floating point is accepted.
"""

from __future__ import annotations

import re
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal, localcontext
from typing import Annotated, Literal

from pydantic import (
    AwareDatetime,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    PlainSerializer,
    StringConstraints,
    WithJsonSchema,
    field_validator,
)


class StrictModel(BaseModel):
    """All public contracts reject unknown keys and implicit scalar coercion."""

    model_config = ConfigDict(extra="forbid", strict=True, validate_assignment=True)


def _exact_decimal(value: object, places: int) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        raise ValueError("decimal_string_required")
    if isinstance(value, str) and (
        len(value) > 80 or re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value) is None
    ):
        raise ValueError("plain_decimal_required")
    try:
        result = Decimal(value)
    except (ValueError, ArithmeticError):
        raise ValueError("invalid_decimal") from None
    if not result.is_finite():
        raise ValueError("finite_decimal_required")
    exponent = result.as_tuple().exponent
    # Pydantic ignores trailing fractional zeros for decimal_places. Enforce the
    # wire precision as well, including zero values with adversarial exponents.
    if not isinstance(exponent, int) or not -places <= exponent <= 18:
        raise ValueError("decimal_precision_exceeded")
    return result.copy_abs() if result == 0 else result


def _aware_timestamp(value: object) -> object:
    # FastAPI receives JSON objects, rather than model_validate_json input.
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            raise ValueError("invalid_timestamp") from None
    return value


Identifier = Annotated[str, StringConstraints(min_length=1, max_length=128)]
ShortText = Annotated[str, StringConstraints(min_length=1, max_length=256)]
ReasonText = Annotated[str, StringConstraints(min_length=1, max_length=2000)]
Quantity = Annotated[
    Decimal,
    BeforeValidator(lambda value: _exact_decimal(value, 6)),
    Field(ge=0, max_digits=18, decimal_places=6),
    PlainSerializer(lambda value: format(value, "f"), return_type=str),
    WithJsonSchema({"type": "string", "pattern": r"^[0-9]+(?:\.[0-9]{1,6})?$"}),
]
Price = Annotated[
    Decimal,
    BeforeValidator(lambda value: _exact_decimal(value, 4)),
    Field(ge=0, max_digits=18, decimal_places=4),
    PlainSerializer(lambda value: format(value, "f"), return_type=str),
    WithJsonSchema({"type": "string", "pattern": r"^[0-9]+(?:\.[0-9]{1,4})?$"}),
]
Timestamp = Annotated[AwareDatetime, BeforeValidator(_aware_timestamp)]


class Evidence(StrictModel):
    """An unverified model claim tied to an immutable source identifier."""

    source_id: Identifier
    field: Annotated[str, StringConstraints(min_length=1, max_length=256)] | None = None
    text: Annotated[str, StringConstraints(min_length=1, max_length=4000)] | None = None

    @field_validator("source_id")
    @classmethod
    def nonblank_source_id(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("source_id_required")
        return value


class CandidateItem(StrictModel):
    """An uncertain line. Existing line IDs may be retained on amendment."""

    line_id: Identifier | None = None
    sku: ShortText | None = None
    name: ShortText | None = None
    quantity: Quantity | None = None
    unit: Annotated[str, StringConstraints(min_length=1, max_length=32)] | None = None
    unit_price: Price | None = None


class CandidateEvent(StrictModel):
    """One proposed business action; all uncertain business values stay null."""

    action: Literal["create", "amend", "cancel"]
    target_order_id: Identifier | None = None
    expected_order_version: Annotated[int, Field(ge=1)] | None = None
    customer: ShortText | None = None
    external_id: Identifier | None = None
    currency: Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")] | None = None
    occurred_at: Timestamp | None = None
    reason: ReasonText | None = None
    items: Annotated[list[CandidateItem], Field(max_length=100)] = Field(default_factory=list)
    evidence: Annotated[list[Evidence], Field(max_length=200)] = Field(default_factory=list)
    warnings: Annotated[list[ReasonText], Field(max_length=100)] = Field(default_factory=list)
    missing_reasons: Annotated[list[ReasonText], Field(max_length=100)] = Field(
        default_factory=list
    )


class Candidate(StrictModel):
    """Versioned envelope, always requiring human review before persistence."""

    schema_version: Literal["1"]
    events: Annotated[list[CandidateEvent], Field(min_length=1, max_length=50)]
    warnings: Annotated[list[ReasonText], Field(max_length=100)] = Field(default_factory=list)
    missing_reasons: Annotated[list[ReasonText], Field(max_length=100)] = Field(
        default_factory=list
    )


# This initial policy is deliberately finite. Unsupported currencies need a
# reviewed precision policy rather than silently inheriting two decimal places.
CURRENCY_MINOR_UNITS = {"CNY": 2, "USD": 2, "EUR": 2, "GBP": 2, "JPY": 0}


class ConfirmationError(ValueError):
    """A stable, value-free review failure safe to expose at API boundaries."""

    code = "confirmation_invalid"

    def __init__(self, fields: list[str]) -> None:
        self.fields = fields
        super().__init__(self.code)


def _present(value: str | None) -> bool:
    return value is not None and bool(value.strip())


def validate_confirmation(
    event: CandidateEvent, sku_catalog: set[str] | frozenset[str]
) -> CandidateEvent:
    """Validate a human-reviewed full replacement, without changing any value.

    Amendments replace the complete active line set, preserving supplied IDs.
    Callers must verify source IDs, target existence and optimistic-lock version
    in their transaction. A cancellation needs no fabricated customer or items.
    """
    fields: list[str] = []
    if event.action in {"amend", "cancel"}:
        if not _present(event.target_order_id):
            fields.append("target_order_id")
        if event.expected_order_version is None:
            fields.append("expected_order_version")
        if not _present(event.reason):
            fields.append("reason")
    elif event.target_order_id is not None or event.expected_order_version is not None:
        fields.append("create_target_forbidden")
    if event.action == "cancel":
        if fields:
            raise ConfirmationError(fields)
        return event
    if not _present(event.customer):
        fields.append("customer")
    if event.currency not in CURRENCY_MINOR_UNITS:
        fields.append("currency")
    if not event.items:
        fields.append("items")
    seen_line_ids: set[str] = set()
    for index, item in enumerate(event.items):
        prefix = f"items.{index}"
        if not _present(item.sku) or item.sku not in sku_catalog:
            fields.append(f"{prefix}.sku")
        if not _present(item.name):
            fields.append(f"{prefix}.name")
        if item.quantity is None or item.quantity <= 0:
            fields.append(f"{prefix}.quantity")
        if not _present(item.unit):
            fields.append(f"{prefix}.unit")
        if item.unit_price is None:
            fields.append(f"{prefix}.unit_price")
        if item.line_id is not None:
            if not _present(item.line_id) or item.line_id in seen_line_ids:
                fields.append(f"{prefix}.line_id")
            seen_line_ids.add(item.line_id)
    if fields:
        raise ConfirmationError(fields)
    return event


def line_total(item: CandidateItem, currency: str = "CNY") -> Decimal:
    """Round each exact line to currency minor units using ROUND_HALF_UP."""
    if currency not in CURRENCY_MINOR_UNITS:
        raise ConfirmationError(["currency"])
    if item.quantity is None or item.unit_price is None:
        raise ConfirmationError(["quantity", "unit_price"])
    with localcontext() as context:
        # 18-digit operands may yield 36 digits; the ambient context is unsafe.
        context.prec = 50
        quantum = Decimal(1).scaleb(-CURRENCY_MINOR_UNITS[currency])
        return (item.quantity * item.unit_price).quantize(quantum, rounding=ROUND_HALF_UP)


def order_total(items: list[CandidateItem], currency: str = "CNY") -> Decimal:
    """Sum already-rounded lines exactly; taxes/discounts are not inferred."""
    if currency not in CURRENCY_MINOR_UNITS:
        raise ConfirmationError(["currency"])
    with localcontext() as context:
        context.prec = 50
        return sum((line_total(item, currency) for item in items), Decimal("0"))
