"""Microsoft Word (``.docx``) → Markdown, for the Documentation Center.

A ``.docx`` opened in Docs is converted to Markdown here and then flows through the SAME
client-side safe renderer the ``.md`` files use (headings, bold/italic, lists, tables). That keeps
one render/sanitize path — the renderer escapes any stray markup, so nothing raw ever reaches the DOM.

Dependency: ``python-docx`` (in requirements.txt). It is imported LAZILY — the backend still starts
without it (mirroring how ``psutil`` / ``PyJWT`` are optional); only opening a ``.docx`` needs it, and
if the package is absent :func:`docx_to_markdown` raises :class:`DocxUnavailable` so the API can return a
clear "install python-docx" message instead of a 500.

Fidelity is deliberately pragmatic (read, not round-trip): headings (``Title`` / ``Heading N``),
paragraphs, **bold** / *italic* runs, bullet & numbered lists (with nesting), and tables → GitHub pipe
tables. Anything exotic degrades to plain text rather than failing.
"""

from __future__ import annotations

from pathlib import Path

# Hard ceiling on the Markdown we emit, so a huge/rogue document can never exhaust memory or the wire.
MAX_MARKDOWN_CHARS = 2_000_000


class DocxUnavailable(RuntimeError):
    """``python-docx`` is not installed on this server (the ``.docx`` cannot be read in-app)."""


def _emphasis(run) -> str:
    """One run → Markdown, applying bold/italic. Leading/trailing spaces are kept OUTSIDE the markers
    so ``** bold **`` (which renders literally) is never produced."""
    text = run.text or ""
    if not text.strip():
        return text                                   # whitespace-only run — keep as-is
    lead = text[: len(text) - len(text.lstrip())]
    trail = text[len(text.rstrip()):]
    core = text.strip()
    bold = bool(run.bold)
    italic = bool(run.italic)
    if bold and italic:
        core = f"***{core}***"
    elif bold:
        core = f"**{core}**"
    elif italic:
        core = f"*{core}*"
    return f"{lead}{core}{trail}"


def _para_text(paragraph) -> str:
    """Inline Markdown for a paragraph (its runs joined, emphasis applied)."""
    if paragraph.runs:
        return "".join(_emphasis(r) for r in paragraph.runs).strip()
    return (paragraph.text or "").strip()


def _heading_level(style_name: str) -> int:
    """Map a Word paragraph style to a Markdown heading level (0 = not a heading)."""
    name = (style_name or "").strip().lower()
    if name in ("title",):
        return 1
    if name.startswith("heading"):
        digits = "".join(ch for ch in name if ch.isdigit())
        if digits:
            return min(6, max(1, int(digits)))
        return 2
    return 0


def _list_kind(paragraph):
    """``(is_list, ordered, level)`` for a paragraph. Level comes from the numbering ``ilvl`` when present;
    ordered vs bullet is inferred from the style name (``List Number*`` → ordered)."""
    try:
        from docx.oxml.ns import qn  # part of python-docx
    except Exception:  # noqa: BLE001
        qn = None
    style = (paragraph.style.name if paragraph.style else "") or ""
    lname = style.lower()
    num_pr = None
    if qn is not None:
        p_pr = paragraph._p.find(qn("w:pPr"))          # noqa: SLF001 — read-only XML access
        if p_pr is not None:
            num_pr = p_pr.find(qn("w:numPr"))
    is_list = num_pr is not None or lname.startswith("list")
    if not is_list:
        return False, False, 0
    level = 0
    if num_pr is not None and qn is not None:
        ilvl = num_pr.find(qn("w:ilvl"))
        if ilvl is not None:
            try:
                level = int(ilvl.get(qn("w:val")) or 0)
            except (TypeError, ValueError):
                level = 0
    ordered = "number" in lname
    return True, ordered, level


def _clean_cell(text: str) -> str:
    """Make a paragraph safe to sit inside one Markdown table cell: no line breaks, no bare pipes."""
    return (text or "").replace("\r", " ").replace("\n", " ").replace("|", "/").strip()


def _table_markdown(table) -> str:
    """A Word table → a GitHub pipe table (first row treated as the header)."""
    rows: list[list[str]] = []
    for tr in table.rows:
        cells = []
        for tc in tr.cells:
            cell_txt = " ".join(_para_text(p) for p in tc.paragraphs if _para_text(p))
            cells.append(_clean_cell(cell_txt))
        rows.append(cells)
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    header = rows[0]
    out = ["| " + " | ".join(header) + " |", "| " + " | ".join(["---"] * width) + " |"]
    for r in rows[1:]:
        out.append("| " + " | ".join(r) + " |")
    return "\n".join(out)


def docx_to_markdown(path: str | Path) -> str:
    """Read a ``.docx`` and return Markdown (see module docstring). Raises :class:`DocxUnavailable` when
    ``python-docx`` is missing, or ``ValueError`` when the file cannot be parsed as a Word document."""
    try:
        import docx  # python-docx — lazy/optional
        from docx.document import Document as _Doc
        from docx.oxml.ns import qn
        from docx.table import Table
        from docx.text.paragraph import Paragraph
    except ImportError as exc:  # package absent
        raise DocxUnavailable(str(exc)) from exc

    try:
        document = docx.Document(str(path))
    except Exception as exc:  # noqa: BLE001 — corrupt / not-a-docx / password-protected
        raise ValueError(f"Not a readable Word document: {exc}") from exc

    blocks: list[str] = []
    pending_list: list[str] = []           # consecutive list items are one block (no blank line between)

    def flush_list() -> None:
        if pending_list:
            blocks.append("\n".join(pending_list))
            pending_list.clear()

    body = document.element.body
    for child in body.iterchildren():
        tag = child.tag
        if tag == qn("w:p"):
            para = Paragraph(child, document)  # type: ignore[arg-type]
            text = _para_text(para)
            level = _heading_level(para.style.name if para.style else "")
            is_list, ordered, ilvl = _list_kind(para)
            if level:
                flush_list()
                blocks.append(f"{'#' * level} {text}" if text else "")
            elif is_list and text:
                marker = "1." if ordered else "-"
                pending_list.append(f"{'  ' * ilvl}{marker} {text}")
            else:
                flush_list()
                blocks.append(text)        # paragraph (possibly empty → blank line)
        elif tag == qn("w:tbl"):
            flush_list()
            tbl = _table_markdown(Table(child, document))  # type: ignore[arg-type]
            if tbl:
                blocks.append(tbl)
    flush_list()

    # Collapse runs of blank blocks, join paragraphs with a blank line between them.
    md_lines: list[str] = []
    for b in blocks:
        if b == "" and (not md_lines or md_lines[-1] == ""):
            continue
        md_lines.append(b)
    markdown = "\n\n".join(md_lines).strip() + "\n"
    if len(markdown) > MAX_MARKDOWN_CHARS:
        markdown = markdown[:MAX_MARKDOWN_CHARS] + "\n\n… [truncated]\n"
    return markdown
