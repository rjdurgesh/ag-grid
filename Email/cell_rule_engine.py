from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal, InvalidOperation
import re
from typing import Any


STYLE_TOKENS: dict[str, str] = {
    "success": "background-color:#dcfce7 !important; color:#166534 !important; font-weight:700;",
    "danger": "background-color:#fee2e2 !important; color:#991b1b !important; font-weight:700;",
    "warning": "background-color:#fef3c7 !important; color:#92400e !important; font-weight:700;",
    "info": "background-color:#dbeafe !important; color:#1e40af !important; font-weight:700;",
    "muted": "background-color:#f1f5f9 !important; color:#475569 !important;",
}


def normalise_key(label: str) -> str:
    key = re.sub(r"[^a-zA-Z0-9]+", "_", str(label).strip().lower())
    return key.strip("_")


def resolve_cell_styles(
    row: Mapping[str, Any] | Sequence[Any],
    cell_rules: Sequence[Mapping[str, Any]],
    columns: Sequence[Mapping[str, Any]] = (),
    style_tokens: Mapping[str, str] | None = None,
) -> dict[str, str]:
    styles: dict[str, str] = {}
    allowed_styles = style_tokens or STYLE_TOKENS

    for rule in cell_rules:
        column_key = resolve_rule_column_key(rule, columns)
        if not column_key:
            continue

        value = get_cell_value(row, column_key, columns)

        if rule_matches(value, row, rule, columns):
            style_name = str(rule.get("style", "")).strip().lower()
            style = allowed_styles.get(style_name)
            if style:
                for target_key in resolve_target_column_keys(rule, columns, column_key):
                    styles[target_key] = style

    return styles


def resolve_rule_column_key(rule: Mapping[str, Any], columns: Sequence[Mapping[str, Any]]) -> str:
    if "source_column_index" in rule:
        return column_key_by_index(rule["source_column_index"], columns, offset=0)

    if "source_column_position" in rule:
        return column_key_by_index(rule["source_column_position"], columns, offset=1)

    if "source_column" in rule:
        return normalise_key(str(rule["source_column"]))

    if "column_index" in rule:
        return column_key_by_index(rule["column_index"], columns, offset=0)

    if "column_position" in rule:
        return column_key_by_index(rule["column_position"], columns, offset=1)

    if "column" in rule:
        return normalise_key(str(rule["column"]))

    return ""


def resolve_target_column_keys(
    rule: Mapping[str, Any],
    columns: Sequence[Mapping[str, Any]],
    default_column_key: str,
) -> list[str]:
    if str(rule.get("target", "")).strip().lower() == "row":
        return [str(column["key"]) for column in columns]

    target_keys: list[str] = []

    for index in as_list(rule.get("target_column_indices")):
        target_keys.append(column_key_by_index(index, columns, offset=0))

    for position in as_list(rule.get("target_column_positions")):
        target_keys.append(column_key_by_index(position, columns, offset=1))

    for column in as_list(rule.get("target_columns")):
        target_keys.append(normalise_key(str(column)))

    if "target_column_index" in rule:
        target_keys.append(column_key_by_index(rule["target_column_index"], columns, offset=0))

    if "target_column_position" in rule:
        target_keys.append(column_key_by_index(rule["target_column_position"], columns, offset=1))

    if "target_column" in rule:
        target_keys.append(normalise_key(str(rule["target_column"])))

    return unique_or_default(target_keys, default_column_key)


def unique_or_default(values: Sequence[str], default_value: str) -> list[str]:
    unique_values = []
    for value in values:
        if value and value not in unique_values:
            unique_values.append(value)
    return unique_values or [default_value]


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    if isinstance(value, Sequence):
        return list(value)
    return [value]


def column_key_by_index(index_value: Any, columns: Sequence[Mapping[str, Any]], *, offset: int) -> str:
    if not columns:
        raise ValueError("Column-based rules by index require the columns metadata.")

    try:
        index = int(index_value) - offset
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Column index must be an integer: {index_value!r}") from exc

    if index < 0 or index >= len(columns):
        raise IndexError(f"Column index is out of range: {index_value!r}")

    return str(columns[index]["key"])


def get_cell_value(
    row: Mapping[str, Any] | Sequence[Any],
    column_key: str,
    columns: Sequence[Mapping[str, Any]],
) -> Any:
    if isinstance(row, Mapping):
        return row.get(column_key)

    column_index = next(
        (index for index, column in enumerate(columns) if str(column.get("key")) == column_key),
        None,
    )
    if column_index is None:
        return None

    return row[column_index] if column_index < len(row) else None


def rule_matches(
    value: Any,
    row: Mapping[str, Any] | Sequence[Any],
    rule: Mapping[str, Any],
    columns: Sequence[Mapping[str, Any]],
) -> bool:
    operator = str(rule.get("operator", "==")).strip().lower()

    if operator in {"is_blank", "blank"}:
        return is_blank(value)
    if operator in {"is_not_blank", "not_blank"}:
        return not is_blank(value)

    compare_value = resolve_compare_value(row, rule, columns)
    expected = compare_value if has_compare_reference(rule) else rule.get("value")

    if operator in {"changed"}:
        return text_value(value) != text_value(expected)
    if operator in {"unchanged"}:
        return text_value(value) == text_value(expected)

    if operator in {">", ">=", "<", "<=", "between"}:
        return numeric_rule_matches(value, expected, operator)

    if operator in {"diff_abs_gt", "diff_abs_gte", "diff_abs_lt", "diff_abs_lte"}:
        return numeric_difference_rule_matches(value, expected, rule.get("value"), operator)

    if operator in {"pct_diff_gt", "pct_diff_gte", "pct_diff_lt", "pct_diff_lte"}:
        return percent_difference_rule_matches(value, expected, rule.get("value"), operator)

    actual_text = text_value(value)
    expected_text = text_value(expected)

    if operator in {"=", "=="}:
        return actual_text == expected_text
    if operator == "!=":
        return actual_text != expected_text
    if operator == "contains":
        return expected_text in actual_text
    if operator == "not_contains":
        return expected_text not in actual_text
    if operator == "startswith":
        return actual_text.startswith(expected_text)
    if operator == "endswith":
        return actual_text.endswith(expected_text)
    if operator == "in":
        expected_values = expected if isinstance(expected, Sequence) and not isinstance(expected, str) else str(expected).split(",")
        return actual_text in {str(item).strip() for item in expected_values}
    if operator == "not_in":
        expected_values = expected if isinstance(expected, Sequence) and not isinstance(expected, str) else str(expected).split(",")
        return actual_text not in {str(item).strip() for item in expected_values}

    raise ValueError(f"Unsupported rule operator: {operator}")


def resolve_compare_value(
    row: Mapping[str, Any] | Sequence[Any],
    rule: Mapping[str, Any],
    columns: Sequence[Mapping[str, Any]],
) -> Any:
    if "compare_to_column_index" in rule:
        return get_cell_value(row, column_key_by_index(rule["compare_to_column_index"], columns, offset=0), columns)

    if "compare_to_column_position" in rule:
        return get_cell_value(row, column_key_by_index(rule["compare_to_column_position"], columns, offset=1), columns)

    if "compare_to_column" in rule:
        return get_cell_value(row, normalise_key(str(rule["compare_to_column"])), columns)

    if "compare_to_value" in rule:
        return rule["compare_to_value"]

    return None


def has_compare_reference(rule: Mapping[str, Any]) -> bool:
    return any(
        key in rule
        for key in {
            "compare_to_column_index",
            "compare_to_column_position",
            "compare_to_column",
            "compare_to_value",
        }
    )


def text_value(value: Any) -> str:
    return "" if value is None else str(value)


def is_blank(value: Any) -> bool:
    return text_value(value).strip() == ""


def numeric_rule_matches(value: Any, expected: Any, operator: str) -> bool:
    actual_number = to_decimal(value)

    if operator == "between":
        if not isinstance(expected, Sequence) or isinstance(expected, str) or len(expected) != 2:
            raise ValueError("The 'between' operator requires a two-value sequence.")
        lower = to_decimal(expected[0])
        upper = to_decimal(expected[1])
        return lower <= actual_number <= upper

    expected_number = to_decimal(expected)

    if operator == ">":
        return actual_number > expected_number
    if operator == ">=":
        return actual_number >= expected_number
    if operator == "<":
        return actual_number < expected_number
    if operator == "<=":
        return actual_number <= expected_number

    raise ValueError(f"Unsupported numeric rule operator: {operator}")


def numeric_difference_rule_matches(value: Any, expected: Any, threshold: Any, operator: str) -> bool:
    difference = abs(to_decimal(value) - to_decimal(expected))
    threshold_number = to_decimal(threshold)

    if operator == "diff_abs_gt":
        return difference > threshold_number
    if operator == "diff_abs_gte":
        return difference >= threshold_number
    if operator == "diff_abs_lt":
        return difference < threshold_number
    if operator == "diff_abs_lte":
        return difference <= threshold_number

    raise ValueError(f"Unsupported difference rule operator: {operator}")


def percent_difference_rule_matches(value: Any, expected: Any, threshold: Any, operator: str) -> bool:
    base_number = abs(to_decimal(expected))
    if base_number == 0:
        return False

    percentage = abs(to_decimal(value) - to_decimal(expected)) / base_number * Decimal("100")
    threshold_number = to_decimal(threshold)

    if operator == "pct_diff_gt":
        return percentage > threshold_number
    if operator == "pct_diff_gte":
        return percentage >= threshold_number
    if operator == "pct_diff_lt":
        return percentage < threshold_number
    if operator == "pct_diff_lte":
        return percentage <= threshold_number

    raise ValueError(f"Unsupported percentage difference rule operator: {operator}")


def to_decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"Value cannot be compared numerically: {value!r}") from exc
