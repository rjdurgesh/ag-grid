from pathlib import Path

from ols_email_renderer import build_email_context, render_email_from_clob


OUTPUT_PATH = Path(__file__).resolve().parent / "rendered_from_real_clob_usage.html"
BASE_DIR = Path(__file__).resolve().parent


def fetch_template_from_db() -> tuple[str, str]:
    """Replace this stub with your real DB call."""
    template_clob = (BASE_DIR / "generic_ols_batch_email.jinja").read_text(encoding="utf-8")
    subject_template = "OLS {{ interface_name }} {{ status_theme.label }} - {{ business_date }}"
    return template_clob, subject_template


def main() -> None:
    template_clob, subject_template = fetch_template_from_db()

    headers = ["LMA Code", "17-June-2026", "18-June-2026"]
    records = [
        ("IXLQA12", "100", "110"),
        ("IXLQA15", "90", "90"),
    ]
    cell_rules = [
        {"column_index": 2, "operator": "!=", "compare_to_column_index": 1, "style": "danger"},
        {"column_index": 2, "operator": "!=", "compare_to_column_index": 1, "target_column_index": 0, "style": "warning"},
    ]

    context = build_email_context(
        interface_name="LMA Daily Comparison",
        headers=headers,
        records=records,
        fixing_date="17-June-2026",
        loaded_date="18-June-2026",
        numeric_columns=["17-June-2026", "18-June-2026"],
        code_columns=["LMA Code"],
        cell_rules=cell_rules,
        body_message=(
            "The LMA values for 17-June-2026 and 18-June-2026 have been compared. "
            "Any changed value is highlighted below for review."
        ),
        table_heading_label="Comparison:",
        table_heading_value="17-June-2026 vs 18-June-2026",
        table_title="LMA daily value comparison",
    )

    rendered_email = render_email_from_clob(
        template_clob,
        context,
        subject_template=subject_template,
    )

    OUTPUT_PATH.write_text(rendered_email.html, encoding="utf-8")

    print(f"Subject: {rendered_email.subject}")
    print(f"HTML file: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
