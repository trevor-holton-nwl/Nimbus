"""Shared helpers for the backend CSV exports (plan Part 1 #8).

`csv_cell` neutralises spreadsheet-formula injection on TEXT cells only (a
string starting with = + - @ or a tab/CR gets a leading apostrophe); numbers,
dates and None pass through untouched. `CSV_BOM` makes Excel read UTF-8.
"""
import datetime
import re

CSV_BOM = "\ufeff"
_FORMULA_LEAD = ("=", "+", "-", "@", "\t", "\r")


def csv_cell(value):
    if isinstance(value, str) and value.startswith(_FORMULA_LEAD):
        return "'" + value
    return value


def csv_row(values) -> list:
    return [csv_cell(v) for v in values]


def us_date_cell(value, *, seconds: bool = True):
    """User-facing CSV dates are MM/DD/YYYY (datetimes MM/DD/YYYY HH:MM:SS, or
    HH:MM with seconds=False). Only python date/datetime objects are touched,
    formatted from their own fields (no timezone conversion); every other type
    passes through unchanged."""
    if isinstance(value, datetime.datetime):
        return value.strftime("%m/%d/%Y %H:%M:%S" if seconds else "%m/%d/%Y %H:%M")
    if isinstance(value, datetime.date):
        return value.strftime("%m/%d/%Y")
    return value


def us_date_row(values, *, seconds: bool = True) -> list:
    return [us_date_cell(v, seconds=seconds) for v in values]


_ISO_TEXT_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$")


def us_date_any(value):
    """us_date_cell(seconds=False) plus ISO date / date-time STRINGS
    (YYYY-MM-DD[THH:MM[:SS[.f]][tz]]) -> MM/DD/YYYY[ HH:MM], for rows that were already
    serialised (e.g. the SAP staging helpers). Built from the string's own parts, no
    timezone conversion. Any other value, or a string that is not an ISO date, is returned unchanged."""
    if isinstance(value, str):
        m = _ISO_TEXT_RE.match(value)
        if not m:
            return value
        out = f"{m.group(2)}/{m.group(3)}/{m.group(1)}"
        return f"{out} {m.group(4)}:{m.group(5)}" if m.group(4) else out
    return us_date_cell(value, seconds=False)
