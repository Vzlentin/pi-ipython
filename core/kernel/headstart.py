"""Load, save and inspect common data in one call.

`charge` reads a file into a DataFrame or a plain value. `sauve` writes a
DataFrame, a list of records or a plain value to a file. `montre` prints a
short view of a value, `combien` counts rows by key, and `compare` lists the
rows that differ between two frames. Every verb also takes records, a list of
dicts.
"""
import json
import re
import tomllib
from pathlib import Path

import pandas as pd

__all__ = ["charge", "sauve", "montre", "combien", "compare"]

EXCEL_SUFFIXES = {".xlsx", ".xlsm", ".xls", ".xlsb", ".ods"}
LEADING_ZERO = re.compile(r"^[+-]?0\d")
# Naive upper limit on xlsx column widths, in characters. Change it if long text needs more room.
MAX_COLUMN_WIDTH = 60
# Text budget of one row of n in montre, in characters.
CHARACTERS_PER_ROW = 80
_shell = None
_shown = None


def __dir__():
    return __all__


def install(shell):
    """Hide the result of a cell whose last line is a montre call: montre already printed its view."""
    global _shell

    _shell = shell
    shell.displayhook.register_hook(_skip_shown)
    shell.events.register("post_execute", _forget)


def _skip_shown(msg):
    exec_result = _shell.displayhook.exec_result

    if _shown is not None and exec_result is not None and exec_result.result is _shown:
        return None

    return msg


def _forget():
    global _shown

    _shown = None


def _records(x):
    """Turn a list of dicts into a DataFrame and give back any other value as it is."""
    if isinstance(x, list) and all(isinstance(item, dict) for item in x):
        return pd.DataFrame(x)

    return x


def _frame(data, verb):
    if not isinstance(data, pd.DataFrame):
        raise TypeError(f"{verb} needs a DataFrame or records, not {type(data).__name__}")

    return data


def _unsupported(verb, suffixes, path):
    suffix = path.suffix or "files without a suffix"
    return f"{verb} cannot use {suffix}: it supports {', '.join(sorted(suffixes))}: {path}"


def charge(path, sheet=None):
    """Read a file (or records) into a DataFrame or a plain value. Only workbooks take a sheet."""
    if isinstance(path, list):
        return _records(path)

    path = Path(path)
    suffix = path.suffix.lower()

    if suffix in EXCEL_SUFFIXES:
        return _charge_excel(path, sheet)

    if sheet is not None:
        raise ValueError(f"charge takes a sheet only for {', '.join(sorted(EXCEL_SUFFIXES))}: {path}")

    if suffix not in READERS:
        raise ValueError(_unsupported("charge", READERS.keys() | EXCEL_SUFFIXES, path))

    return READERS[suffix](path)


def _charge_jsonl(path):
    rows = []
    bad = 0

    with path.open(encoding="utf-8") as file:
        for line in file:
            if not line.strip():
                continue

            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                row = None

            if isinstance(row, dict):
                rows.append(row)
            else:
                bad += 1

    if bad:
        print(f"skipped {bad} bad line(s)")

    return pd.DataFrame(rows)


def _charge_csv(path):
    # Two reads: the first finds the columns with leading-zero codes, the second keeps pandas' own type inference.
    text = pd.read_csv(path, dtype=str)
    keep = [name for name in text.columns if text[name].str.match(LEADING_ZERO, na=False).any()]

    return pd.read_csv(path, dtype=dict.fromkeys(keep, str))


def _charge_json(path):
    with path.open(encoding="utf-8") as file:
        return _records(json.load(file))


def _charge_toml(path):
    with path.open("rb") as file:
        return tomllib.load(file)


def _charge_excel(path, sheet):
    with pd.ExcelFile(path, engine="calamine") as book:
        name = book.sheet_names[0] if sheet is None else sheet
        others = [other for other in book.sheet_names if other != name]

        if others:
            print(f"other sheets: {', '.join(map(str, others))}")

        return pd.read_excel(book, sheet_name=name, dtype=object).infer_objects()


READERS = {".jsonl": _charge_jsonl, ".csv": _charge_csv, ".json": _charge_json, ".toml": _charge_toml}


def sauve(path, data):
    """Write data to a .json, .jsonl, .csv or .xlsx file and return its path."""
    if isinstance(data, str):
        raise TypeError("sauve does not write text: use Pi's write tool")

    path = Path(path)
    suffix = path.suffix.lower()

    if suffix not in WRITERS:
        raise ValueError(f"{_unsupported('sauve', WRITERS.keys(), path)}. Use Pi's write tool for other files.")

    WRITERS[suffix](path, _records(data))

    return path


def _sauve_json(path, data):
    if isinstance(data, pd.DataFrame):
        data.to_json(path, orient="records", date_format="iso")
        return

    with path.open("w", encoding="utf-8") as file:
        json.dump(data, file)


def _sauve_jsonl(path, data):
    _frame(data, "sauve .jsonl").to_json(path, orient="records", lines=True, date_format="iso")


def _sauve_csv(path, data):
    _frame(data, "sauve .csv").to_csv(path, index=False)


def _sauve_xlsx(path, data):
    if isinstance(data, dict):
        sheets = {name: _frame(_records(sheet), f"sauve .xlsx sheet {name!r}") for name, sheet in data.items()}
    else:
        sheets = {"Sheet1": _frame(data, "sauve .xlsx")}

    with pd.ExcelWriter(path, engine="xlsxwriter") as writer:
        for name, frame in sheets.items():
            frame.to_excel(writer, sheet_name=name, index=False)
            sheet = writer.sheets[name]
            sheet.freeze_panes(1, 0)
            sheet.autofilter(0, 0, len(frame), len(frame.columns) - 1)

            for index, column in enumerate(frame.columns):
                width = max([len(str(column)), *frame[column].astype(str).str.len()])
                sheet.set_column(index, index, min(width + 2, MAX_COLUMN_WIDTH))


WRITERS = {".json": _sauve_json, ".jsonl": _sauve_jsonl, ".csv": _sauve_csv, ".xlsx": _sauve_xlsx}


def montre(x, n=40):
    """Print a short view of x, show it only once, and return x."""
    global _shown

    view = _records(x)
    half = max(n // 2, 1)

    if isinstance(view, (pd.DataFrame, pd.Series)) and len(view) > 2 * half:
        print(view.to_string(max_rows=2 * half, min_rows=2 * half))
        print(f"[{len(view) - 2 * half:,} of {len(view):,} rows hidden]")
    else:
        text = view if isinstance(view, str) else repr(view)
        keep = half * CHARACTERS_PER_ROW

        if len(text) > 2 * keep:
            text = f"{text[:keep]}\n[… {len(text) - 2 * keep:,} characters hidden …]\n{text[-keep:]}"

        print(text)

    _shown = x

    return x


def combien(df, key, *keys, n=20):
    """Count rows by keys, NaN included, with the count n and its share of all rows."""
    frame = _frame(_records(df), "combien")
    counts = frame.value_counts([key, *keys], dropna=False).head(n).reset_index(name="n")
    counts["share"] = counts["n"] / len(frame)

    return counts


def compare(a, b, key):
    """List the rows of a and b that differ on key: only a, only b, or changed."""
    a = _frame(_records(a), "compare")
    b = _frame(_records(b), "compare")
    merged = a.merge(b, on=key, how="outer", indicator=True, suffixes=("_a", "_b"), validate="1:1").set_index(key)
    state = merged.pop("_merge").map({"left_only": "only a", "right_only": "only b", "both": "changed"}).astype(str)
    differs = state != "changed"

    for name in a.columns.intersection(b.columns).difference(merged.index.names):
        left = merged[f"{name}_a"]
        right = merged[f"{name}_b"]
        differs |= left.ne(right).fillna(True) & ~(left.isna() & right.isna())

    merged.insert(0, "state", state)

    return merged[differs].reset_index()
