# Generic Cell Rule Reference

Rules are plain dictionaries, so they can be stored in Python, JSON, or a DB config table.
The rule engine is in `cell_rule_engine.py` and can be imported by any future email or report renderer.

## Column Selectors

Use zero-based column indexes when your data is naturally row based:

```python
{"column_index": 3, "operator": ">", "value": "50", "style": "success"}
```

Use one-based column positions when the config is maintained by business users:

```python
{"column_position": 4, "operator": ">", "value": "50", "style": "success"}
```

Use a column name when readability matters:

```python
{"column": "Exchange Rate EUR", "operator": ">", "value": "50", "style": "success"}
```

## Cross-Column Compare

Compare one column with another column in the same row:

```python
{"column_index": 2, "operator": "!=", "compare_to_column_index": 1, "style": "danger"}
```

This means: if `row[2] != row[1]`, make `row[2]` red.

For your LMA example:

```python
headers = ["LMA Code", "17-June-2026", "18-June-2026"]
records = [
    ("IXLQA12", "100", "110"),
    ("IXLQA15", "90", "90"),
]

cell_rules = [
    {"column_index": 2, "operator": "!=", "compare_to_column_index": 1, "style": "danger"},
    {"column_index": 2, "operator": "!=", "compare_to_column_index": 1, "target_column_index": 0, "style": "warning"},
]
```

The first rule highlights the changed value.
The second rule also flags the `LMA Code` cell for that row.

## Targeting

By default, the same cell being tested receives the style.

Style a different column:

```python
{"column_index": 2, "operator": "!=", "compare_to_column_index": 1, "target_column_index": 0, "style": "warning"}
```

Style multiple columns:

```python
{"column_index": 2, "operator": "!=", "compare_to_column_index": 1, "target_column_indices": [0, 2], "style": "danger"}
```

Style the full row:

```python
{"column_index": 2, "operator": "!=", "compare_to_column_index": 1, "target": "row", "style": "warning"}
```

## Supported Styles

- `success` - green
- `danger` - red
- `warning` - amber
- `info` - blue
- `muted` - grey

## Supported Operators

Numeric:

```python
{"column_index": 3, "operator": ">", "value": "50", "style": "success"}
{"column_index": 3, "operator": ">=", "value": "50", "style": "success"}
{"column_index": 3, "operator": "<", "value": "1", "style": "danger"}
{"column_index": 3, "operator": "<=", "value": "1", "style": "danger"}
{"column_index": 3, "operator": "between", "value": ["1", "50"], "style": "info"}
```

Text:

```python
{"column_index": 0, "operator": "==", "value": "IXLQA12", "style": "info"}
{"column_index": 0, "operator": "!=", "value": "IXLQA12", "style": "warning"}
{"column_index": 0, "operator": "contains", "value": "QA", "style": "info"}
{"column_index": 0, "operator": "not_contains", "value": "QA", "style": "warning"}
{"column_index": 0, "operator": "startswith", "value": "IXL", "style": "info"}
{"column_index": 0, "operator": "endswith", "value": "12", "style": "info"}
{"column_index": 0, "operator": "in", "value": ["IXLQA12", "IXLQA15"], "style": "success"}
{"column_index": 0, "operator": "not_in", "value": ["IXLQA12", "IXLQA15"], "style": "danger"}
```

Blank checks:

```python
{"column_index": 2, "operator": "is_blank", "style": "danger"}
{"column_index": 2, "operator": "is_not_blank", "style": "success"}
```

Cross-column equality:

```python
{"column_index": 2, "operator": "changed", "compare_to_column_index": 1, "style": "danger"}
{"column_index": 2, "operator": "unchanged", "compare_to_column_index": 1, "style": "success"}
```

Absolute numeric difference:

```python
{"column_index": 2, "operator": "diff_abs_gt", "compare_to_column_index": 1, "value": "5", "style": "danger"}
{"column_index": 2, "operator": "diff_abs_gte", "compare_to_column_index": 1, "value": "5", "style": "danger"}
{"column_index": 2, "operator": "diff_abs_lt", "compare_to_column_index": 1, "value": "5", "style": "success"}
{"column_index": 2, "operator": "diff_abs_lte", "compare_to_column_index": 1, "value": "5", "style": "success"}
```

Percentage difference:

```python
{"column_index": 2, "operator": "pct_diff_gt", "compare_to_column_index": 1, "value": "10", "style": "danger"}
{"column_index": 2, "operator": "pct_diff_gte", "compare_to_column_index": 1, "value": "10", "style": "danger"}
{"column_index": 2, "operator": "pct_diff_lt", "compare_to_column_index": 1, "value": "10", "style": "success"}
{"column_index": 2, "operator": "pct_diff_lte", "compare_to_column_index": 1, "value": "10", "style": "success"}
```

Rule order matters. If two rules target the same cell, the later matching rule wins.
