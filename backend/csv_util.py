"""Shared helpers for the backend CSV exports (plan Part 1 #8).

`csv_cell` neutralises spreadsheet-formula injection on TEXT cells only (a
string starting with = + - @ or a tab/CR gets a leading apostrophe); numbers,
dates and None pass through untouched. `CSV_BOM` makes Excel read UTF-8.
"""
CSV_BOM = "\ufeff"
_FORMULA_LEAD = ("=", "+", "-", "@", "\t", "\r")


def csv_cell(value):
    if isinstance(value, str) and value.startswith(_FORMULA_LEAD):
        return "'" + value
    return value


def csv_row(values) -> list:
    return [csv_cell(v) for v in values]
