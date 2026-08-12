from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jinja2 import BaseLoader, Environment, FileSystemLoader, StrictUndefined

from cell_rule_engine import normalise_key as header_key
from cell_rule_engine import resolve_cell_styles


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_TEMPLATE_PATH = BASE_DIR / "generic_ols_batch_email.jinja"


STATUS_THEMES: dict[str, dict[str, str]] = {
    "SUCCESS": {
        "label": "Success",
        "title": "Batch Completed Successfully",
        "message": "No action is required. The batch completed and the notification data is available below.",
        "icon_text": "&#10003;",
        "bg_color": "#f3faf5",
        "border_color": "#cce5d5",
        "bar_color": "#2e9d59",
        "icon_bg_color": "#2e9d59",
        "icon_color": "#ffffff",
        "title_color": "#1b5e20",
        "text_color": "#55705d",
    },
    "FAILED": {
        "label": "Failed",
        "title": "Batch Failed",
        "message": "The batch did not complete successfully. Exchange-rate data is not displayed in this email.",
        "icon_text": "!",
        "bg_color": "#fff5f5",
        "border_color": "#fecaca",
        "bar_color": "#dc2626",
        "icon_bg_color": "#dc2626",
        "icon_color": "#ffffff",
        "title_color": "#991b1b",
        "text_color": "#7f1d1d",
    },
    "WARNING": {
        "label": "Warning",
        "title": "Batch Completed With Warning",
        "message": "The batch completed, but one or more checks require review.",
        "icon_text": "!",
        "bg_color": "#fffaf0",
        "border_color": "#fed7aa",
        "bar_color": "#f59e0b",
        "icon_bg_color": "#f59e0b",
        "icon_color": "#111827",
        "title_color": "#92400e",
        "text_color": "#7c2d12",
    },
    "NO_DATA": {
        "label": "No Data",
        "title": "Batch Completed With No Data",
        "message": "The batch completed, but no exchange-rate rows were returned for this notification.",
        "icon_text": "i",
        "bg_color": "#f7f9fb",
        "border_color": "#dce4eb",
        "bar_color": "#607d8b",
        "icon_bg_color": "#607d8b",
        "icon_color": "#ffffff",
        "title_color": "#37474f",
        "text_color": "#546e7a",
    },
}


DEFAULT_SUBJECT_TEMPLATE = "OLS {{ interface_name }} {{ status_theme.label }} - {{ business_date }}"


@dataclass(frozen=True)
class RenderedEmail:
    subject: str
    html: str


def build_environment(template_dir: Path | None = None) -> Environment:
    loader = FileSystemLoader(str(template_dir or BASE_DIR))
    return Environment(
        loader=loader,
        autoescape=True,
        trim_blocks=True,
        lstrip_blocks=True,
        undefined=StrictUndefined,
    )


def build_string_environment() -> Environment:
    return Environment(
        loader=BaseLoader(),
        autoescape=True,
        trim_blocks=True,
        lstrip_blocks=True,
        undefined=StrictUndefined,
    )


def build_columns(
    headers: Sequence[str],
    *,
    numeric_columns: Sequence[str] = (),
    code_columns: Sequence[str] = (),
    nowrap_columns: Sequence[str] = (),
    right_align_columns: Sequence[str] = (),
) -> list[dict[str, Any]]:
    numeric_keys = {header_key(column) for column in numeric_columns}
    code_keys = {header_key(column) for column in code_columns}
    nowrap_keys = {header_key(column) for column in nowrap_columns}
    right_align_keys = {header_key(column) for column in right_align_columns} | numeric_keys

    columns = []
    for header in headers:
        key = header_key(header)
        kind = "number" if key in numeric_keys else "code" if key in code_keys else "text"
        columns.append(
            {
                "key": key,
                "index": len(columns),
                "label": str(header),
                "kind": kind,
                "align": "right" if key in right_align_keys else "left",
                "nowrap": key in nowrap_keys or kind in {"number", "code"},
            }
        )
    return columns


def rows_from_db(headers: Sequence[str], records: Sequence[Any]) -> list[dict[str, Any]]:
    keys = [header_key(header) for header in headers]
    rows = []

    for record in records:
        if isinstance(record, Mapping):
            rows.append({header_key(key): value for key, value in record.items()})
        else:
            rows.append(dict(zip(keys, record, strict=False)))

    return rows


def decorate_rows(
    raw_rows: Sequence[Mapping[str, Any]],
    columns: Sequence[Mapping[str, Any]],
    cell_rules: Sequence[Mapping[str, Any]] = (),
) -> list[dict[str, Any]]:
    decorated = []

    for raw_row in raw_rows:
        normalised_row = {header_key(key): value for key, value in raw_row.items()}
        row_data = {
            str(column["key"]): format_cell_value(normalised_row.get(str(column["key"]), ""))
            for column in columns
        }
        decorated.append(
            {
                "data": row_data,
                "cell_styles": resolve_cell_styles(normalised_row, cell_rules, columns),
            }
        )

    return decorated


def format_cell_value(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


def build_email_context(
    *,
    interface_name: str,
    headers: Sequence[str],
    records: Sequence[Any],
    status: str = "SUCCESS",
    fixing_date: str = "",
    loaded_date: str = "",
    business_date: str = "",
    numeric_columns: Sequence[str] = (),
    code_columns: Sequence[str] = (),
    nowrap_columns: Sequence[str] = (),
    right_align_columns: Sequence[str] = (),
    cell_rules: Sequence[Mapping[str, Any]] = (),
    error: Mapping[str, Any] | None = None,
    auto_no_data_status: bool = True,
    body_message: str | None = None,
    preheader: str | None = None,
    summary_items: Sequence[Mapping[str, str]] | None = None,
    table_heading_label: str = "Exchange Rate Source:",
    table_heading_value: str | None = None,
    table_title: str | None = None,
    email_title: str | None = None,
) -> dict[str, Any]:
    columns = build_columns(
        headers,
        numeric_columns=numeric_columns,
        code_columns=code_columns,
        nowrap_columns=nowrap_columns,
        right_align_columns=right_align_columns,
    )
    raw_rows = rows_from_db(headers, records)
    normalised_status = status.strip().upper()

    if auto_no_data_status and normalised_status == "SUCCESS" and not raw_rows:
        normalised_status = "NO_DATA"

    if normalised_status not in STATUS_THEMES:
        raise ValueError(f"Unsupported email status: {status}")

    context = {
        "email_title": email_title or f"OLS - {interface_name} Batch Notification",
        "brand_name": "OLS",
        "brand_subtitle": "One Liquidity System",
        "notification_label": "Automated Notification",
        "system_name": "OLS",
        "footer_system_name": "One Liquidity System (OLS)",
        "signature": "OLS Team",
        "interface_name": interface_name,
        "status": normalised_status,
        "status_theme": STATUS_THEMES[normalised_status],
        "business_date": business_date or fixing_date or loaded_date or "-",
        "fixing_date": fixing_date or "-",
        "loaded_date": loaded_date or "-",
        "body_message": body_message or build_body_message(normalised_status, interface_name, fixing_date, loaded_date),
        "preheader": preheader or build_preheader(normalised_status, interface_name, fixing_date, loaded_date),
        "summary_items": list(summary_items) if summary_items is not None else build_summary_items(fixing_date, loaded_date, interface_name, len(raw_rows)),
        "summary_item_width": "25%",
        "table_heading_label": table_heading_label,
        "table_heading_value": table_heading_value or interface_name,
        "table_title": table_title or f"Exchange rates {interface_name}",
        "table_aria_label": table_title or f"Exchange rates {interface_name}",
        "columns": columns,
        "rows": decorate_rows(raw_rows, columns, cell_rules),
        "error": dict(error or {}),
    }

    if normalised_status == "FAILED" and not context["error"].get("message"):
        context["error"]["message"] = "The process failed before exchange-rate data could be retrieved."

    return context


def build_body_message(status: str, interface_name: str, fixing_date: str, loaded_date: str) -> str:
    if status == "SUCCESS":
        return (
            f"The daily exchange rates for {interface_name} effective {fixing_date or '-'} "
            f"have been revised and successfully loaded into OLS on {loaded_date or '-'}. "
            "Please find the revised exchange-rate details below for your reference."
        )

    if status == "FAILED":
        return (
            f"The exchange-rate batch for {interface_name} did not complete successfully. "
            "No exchange-rate data is included in this notification."
        )

    if status == "WARNING":
        return (
            f"The exchange-rate batch for {interface_name} completed with warning. "
            "Please review the details below and validate the batch outcome if required."
        )

    return (
        f"The exchange-rate batch for {interface_name} completed, but no exchange-rate rows "
        "were returned for this notification."
    )


def build_preheader(status: str, interface_name: str, fixing_date: str, loaded_date: str) -> str:
    if status == "SUCCESS":
        return f"{interface_name} exchange rates effective {fixing_date or '-'} were loaded into OLS on {loaded_date or '-'}."
    if status == "FAILED":
        return f"{interface_name} exchange-rate batch failed. No data is included."
    if status == "WARNING":
        return f"{interface_name} exchange-rate batch completed with warning."
    return f"{interface_name} exchange-rate batch completed with no data."


def build_summary_items(fixing_date: str, loaded_date: str, interface_name: str, row_count: int) -> list[dict[str, str]]:
    return [
        {"label": "Fixing Date", "value": fixing_date or "-", "width": "25%"},
        {"label": "Loaded Date", "value": loaded_date or "-", "width": "25%"},
        {"label": "Rate Set", "value": interface_name, "width": "25%"},
        {"label": "Rows", "value": str(row_count), "width": "25%"},
    ]


def render_email(
    context: Mapping[str, Any],
    *,
    template_name: str = DEFAULT_TEMPLATE_PATH.name,
    subject_template: str = DEFAULT_SUBJECT_TEMPLATE,
) -> RenderedEmail:
    env = build_environment(DEFAULT_TEMPLATE_PATH.parent)
    html = env.get_template(template_name).render(**context)
    subject = env.from_string(subject_template).render(**context)
    return RenderedEmail(subject=subject, html=html)


def render_email_from_clob(
    template_clob: Any,
    context: Mapping[str, Any],
    *,
    subject_template: str = DEFAULT_SUBJECT_TEMPLATE,
) -> RenderedEmail:
    template_text = read_clob(template_clob)
    env = build_string_environment()
    html = env.from_string(template_text).render(**context)
    subject = env.from_string(subject_template).render(**context)
    return RenderedEmail(subject=subject, html=html)


def read_clob(value: Any) -> str:
    if hasattr(value, "read"):
        return value.read()
    return str(value)


def example_success_context() -> dict[str, Any]:
    headers = ["Frequency", "Fixing Date", "Currency Code", "Exchange Rate EUR"]
    records = [
        ("Daily", "17-Jun-2026", "MTL", ".4293"),
        ("Daily", "17-Jun-2026", "MUR", "57.57462"),
        ("Daily", "17-Jun-2026", "MVR", "17.837752"),
    ]
    cell_rules = [
        {"column_index": 3, "operator": "<", "value": "1", "style": "danger"},
        {"column_index": 3, "operator": ">", "value": "50", "style": "success"},
    ]

    return build_email_context(
        interface_name="DLCR = DLCRI",
        headers=headers,
        records=records,
        fixing_date="17-Jun-2026",
        loaded_date="20-Jun-2026",
        numeric_columns=["Exchange Rate EUR"],
        code_columns=["Currency Code"],
        nowrap_columns=["Fixing Date"],
        cell_rules=cell_rules,
    )


def example_failed_context() -> dict[str, Any]:
    return build_email_context(
        interface_name="REAR = REARI",
        headers=["Frequency", "Fixing Date", "Currency Code", "Exchange Rate EUR"],
        records=[],
        status="FAILED",
        fixing_date="17-Jun-2026",
        loaded_date="20-Jun-2026",
        numeric_columns=["Exchange Rate EUR"],
        code_columns=["Currency Code"],
        error={
            "message": "The DB load step failed while retrieving exchange-rate rows. Please review the batch log.",
            "batch_id": "OLS-EXRATE-20260620-001",
            "reference": "Scheduler run completed with status FAILED",
        },
    )


def example_lma_difference_context() -> dict[str, Any]:
    headers = ["LMA Code", "17-June-2026", "18-June-2026"]
    records = [
        ("IXLQA12", "100", "110"),
        ("IXLQA15", "90", "90"),
    ]
    cell_rules = [
        {
            "column_index": 2,
            "operator": "!=",
            "compare_to_column_index": 1,
            "style": "danger",
        },
        {
            "column_index": 2,
            "operator": "!=",
            "compare_to_column_index": 1,
            "target_column_index": 0,
            "style": "warning",
        },
    ]

    return build_email_context(
        interface_name="LMA Daily Comparison",
        headers=headers,
        records=records,
        fixing_date="17-June-2026",
        loaded_date="18-June-2026",
        numeric_columns=["17-June-2026", "18-June-2026"],
        code_columns=["LMA Code"],
        cell_rules=cell_rules,
        email_title="OLS - LMA Daily Comparison",
        table_heading_label="Comparison:",
        table_heading_value="17-June-2026 vs 18-June-2026",
        table_title="LMA daily value comparison",
        body_message=(
            "The LMA values for 17-June-2026 and 18-June-2026 have been compared. "
            "Any changed value is highlighted below for review."
        ),
        preheader="LMA daily comparison completed. Changed values are highlighted.",
        summary_items=[
            {"label": "Base Date", "value": "17-June-2026", "width": "25%"},
            {"label": "Compare Date", "value": "18-June-2026", "width": "25%"},
            {"label": "Dataset", "value": "LMA Code", "width": "25%"},
            {"label": "Rows", "value": str(len(records)), "width": "25%"},
        ],
    )


def example_clob_render() -> RenderedEmail:
    template_clob_from_db = DEFAULT_TEMPLATE_PATH.read_text(encoding="utf-8")
    subject_template_from_db = "OLS {{ interface_name }} - {{ status_theme.label }} - {{ business_date }}"
    return render_email_from_clob(
        template_clob_from_db,
        example_lma_difference_context(),
        subject_template=subject_template_from_db,
    )


if __name__ == "__main__":
    success_email = render_email(example_success_context())
    failed_email = render_email(example_failed_context())
    lma_email = render_email(example_lma_difference_context())
    clob_email = example_clob_render()

    (BASE_DIR / "rendered_ols_success_example.html").write_text(success_email.html, encoding="utf-8")
    (BASE_DIR / "rendered_ols_failed_example.html").write_text(failed_email.html, encoding="utf-8")
    (BASE_DIR / "rendered_lma_difference_example.html").write_text(lma_email.html, encoding="utf-8")
    (BASE_DIR / "rendered_from_clob_example.html").write_text(clob_email.html, encoding="utf-8")

    print(f"Success subject: {success_email.subject}")
    print(f"Failure subject: {failed_email.subject}")
    print(f"LMA subject: {lma_email.subject}")
    print(f"CLOB subject: {clob_email.subject}")
