# OLS Generic Jinja Email

This setup converts the advanced OLS HTML email into a reusable Jinja template.

## Files

- `generic_ols_batch_email.jinja` - generic email template for success, failure, warning, and no-data cases.
- `ols_email_renderer.py` - Python renderer, DB row normalisation, safe cell-rule handling, and example output generation.
- `cell_rule_engine.py` - reusable rule engine that can be imported by any future email/report template.
- `cell_rule_reference.md` - reusable examples for thresholds, cross-column checks, blank checks, row targeting, and LMA comparison.
- `render_from_clob_usage.py` - simple example showing how to render when the Jinja HTML comes from a DB CLOB variable.
- `email_template_config_oracle.sql` - optional Oracle CLOB table for storing template content in DB.

## Recommended Flow

1. Fetch headers and rows from DB.
2. Build columns from the headers.
3. Build an email context with status `SUCCESS`, `FAILED`, `WARNING`, or `NO_DATA`.
4. Apply cell rules in Python.
5. Render the Jinja template.
6. Send the rendered HTML using your existing mail function.

## Cell Rules

Rules are declarative and safe. Do not store Python expressions or use `eval`.

```python
cell_rules = [
    {"column_index": 3, "operator": "<", "value": "1", "style": "danger"},
    {"column_index": 3, "operator": ">", "value": "50", "style": "success"},
]
```

`column_index` is zero-based, so `3` means the fourth table column, like `row[3]`.

You can still use a column name when that is more readable:

```python
cell_rules = [
    {"column": "Exchange Rate EUR", "operator": "between", "value": ["1", "50"], "style": "info"},
]
```

For business/config tables where users prefer one-based numbering, `column_position` is also supported:

```python
cell_rules = [
    {"column_position": 4, "operator": ">", "value": "50", "style": "success"},
]
```

Supported style names are `success`, `danger`, `warning`, `info`, and `muted`.

Supported operators are `>`, `>=`, `<`, `<=`, `=`, `==`, `!=`, `contains`, `startswith`, `endswith`, `in`, and `between`.

## CLOB Storage

Yes, the Jinja template can be stored in a DB CLOB column. Load the CLOB text, then render it with:

```python
rendered = render_email_from_clob(template_clob, context, subject_template=subject_template)
```

Minimal end-to-end usage:

```python
template_clob = db_row["BODY_TEMPLATE_CLOB"]      # or Oracle CLOB object
subject_template = db_row["SUBJECT_TEMPLATE"]

context = build_email_context(
    interface_name="LMA Daily Comparison",
    headers=["LMA Code", "17-June-2026", "18-June-2026"],
    records=[
        ("IXLQA12", "100", "110"),
        ("IXLQA15", "90", "90"),
    ],
    cell_rules=[
        {"column_index": 2, "operator": "!=", "compare_to_column_index": 1, "style": "danger"},
    ],
)

rendered = render_email_from_clob(template_clob, context, subject_template=subject_template)

with open("output_email.html", "w", encoding="utf-8") as file:
    file.write(rendered.html)
```

For production, keep template metadata such as `template_code`, `template_version`, `is_active`, `subject_template`, and `body_template_clob`. Caching the active template in Python is also recommended so every email does not need an extra template query.
