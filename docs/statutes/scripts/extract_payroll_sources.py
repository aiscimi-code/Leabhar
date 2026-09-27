#!/usr/bin/env python3
"""Fetch the payroll sources (EPIC 20, issue #315) into docs/statutes/.

Usage (from repo root):
  python3 docs/statutes/scripts/extract_payroll_sources.py

Uses the same HTML -> Markdown conversion as extract_vat_sources.py, so the
committed text is the official page's own wording, offset-traceable, with
the page's SHA-256 in the front matter. The LRC revised SWCA s.13 page is
also kept as HTML: its amendment annotations (stripped from the Markdown)
are what date each figure.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_vat_sources import ROOT, fetch, html_to_md, write  # noqa: E402

SOURCES = [
    # (folder, file stem, url, title, citation)
    ("swca-2005", "swca-2005-s13",
     "https://revisedacts.lawreform.ie/eli/2005/act/26/section/13/revised/en/html",
     "SWCA 2005 s.13 (LRC revised)", "SWCA 2005 s.13"),
    ("swmpa-2024", "2024-act-24-s3",
     "https://www.irishstatutebook.ie/eli/2024/act/24/section/3/enacted/en/html",
     "Social Welfare (Miscellaneous Provisions) Act 2024 s.3 (as enacted)", "2024 Act 24 s.3"),
    ("swa-2024", "2024-act-36-s2",
     "https://www.irishstatutebook.ie/eli/2024/act/36/section/2/enacted/en/html",
     "Social Welfare Act 2024 s.2 (as enacted)", "2024 Act 36 s.2"),
    ("swaerss-2025", "2025-act-19-s2",
     "https://www.irishstatutebook.ie/eli/2025/act/19/section/2/enacted/en/html",
     "Social Welfare and Automatic Enrolment Retirement Savings System (Amendment) Act 2025 s.2 (as enacted)",
     "2025 Act 19 s.2"),
    ("ntf-2000", "ntf-2000-s4",
     "https://revisedacts.lawreform.ie/eli/2000/act/41/section/4/revised/en/html",
     "National Training Fund Act 2000 s.4 (LRC revised)", "NTF Act 2000 s.4"),
    ("si-345-2018", "2018-si-345",
     "https://www.irishstatutebook.ie/eli/2018/si/345/made/en/print",
     "Income Tax (Employments) Regulations 2018 (S.I. No. 345 of 2018)", "S.I. 345/2018"),
    ("si-510-2018", "2018-si-510",
     "https://www.irishstatutebook.ie/eli/2018/si/510/made/en/print",
     "Universal Social Charge Regulations 2018 (S.I. No. 510 of 2018)", "S.I. 510/2018"),
]

KEEP_HTML = {"swca-2005-s13", "ntf-2000-s4"}


def main() -> None:
    for folder, stem, url, title, citation in SOURCES:
        raw = ROOT / folder / f"{stem}.html"
        tmp = Path(f"/tmp/payroll-sources/{stem}.html")
        if not tmp.exists():
            fetch(url, tmp)
        html = tmp.read_text(errors="replace")
        write(ROOT / folder / f"{stem}.md", html_to_md(html, title, citation, url))
        if stem in KEEP_HTML:
            raw.write_text(html)
    print("done")


if __name__ == "__main__":
    main()
