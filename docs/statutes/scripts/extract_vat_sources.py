#!/usr/bin/env python3
"""Fetch official HTML/PDF for VAT items 1, 3, 5, 9 into docs/statutes/.

Usage (from repo root):
  python3 docs/statutes/scripts/extract_vat_sources.py
"""
from __future__ import annotations

import hashlib
import re
import time
import urllib.request
from pathlib import Path

try:
    from bs4 import BeautifulSoup
except ImportError as e:
    raise SystemExit("pip install beautifulsoup4 pdfplumber") from e

ROOT = Path(__file__).resolve().parents[1]
UA = {"User-Agent": "Leabhar-vat-extract/1.0"}

VATCA_SECTIONS = [
    2, 3, 5, 6, 9, 10, 12, 16, 19, 20, 22, 26, 27, 28, 34, 35, 36, 37,
    46, 59, 60, 61, 65, 66, 76, 77, 78, 79, 80, 84, 86, 91, 92, 108,
]
VATCA_LETTERED = [
    "91A", "91B", "91C", "91D", "91E", "91F", "91G", "91H", "91I", "91J",
    "92A", "92B", "92C", "92D", "108A", "108B", "108C",
]


def fetch(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        dest.write_bytes(r.read())
    return dest


def html_to_md(html: str, title: str, citation: str, url: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.select("script, style, nav, header, footer, noscript, form"):
        tag.decompose()
    # revisedacts.lawreform.ie has no #content id; <main id="main-content">
    # wraps both the real provision (<section class="section"|"schedule">)
    # and a leading <div class="act-nav"> breadcrumb ("Act as originally
    # enacted" / "Next Section" etc.) that the old #content/main/body
    # fallback let straight through into the flattened text. Selecting the
    # actual provision container directly (confirmed present via a raw-HTML
    # capture: <section class="schedule" id="SCHED2">, and by analogy
    # class="section" for a section page) excludes that chrome at the
    # source rather than trying to filter its text after the fact.
    root = (
        soup.select_one("#content") or soup.select_one("section.section, section.schedule")
        or soup.select_one("main") or soup.body
    )
    # Per-provision "Amendments:" (class="f-notes") and end-of-provision
    # "Editorial Notes:" (class="e-notes") commentary, both wrapped in a
    # shared <div class="annotations">, interleave with the operative text
    # in a way that survives flattening with no reliable line boundary (a
    # wrapped citation like "commenced as per s.\n86." is indistinguishable
    # from a real top-level paragraph "86." starting fresh) - verified via
    # the same raw-HTML capture. Removing the whole block at the HTML level,
    # where its boundary is unambiguous, is the only place this is fixable.
    if root is not None:
        for tag in root.select(".annotations, .commentary-reference"):
            tag.decompose()
        # The literal "[" / "]" bracket characters LRC prints around
        # substituted/inserted text (class="markup") are its own print
        # convention, not part of the statutory wording - the wording
        # itself is in the accompanying class="change" span, which is kept.
        for tag in root.select(".markup"):
            tag.decompose()
    skip = {
        "Home", "Baile", "Acts", "Achtanna", "Introduction", "Alphabetical List",
        "Chronological List", "Annotations", "This Act", "View Full Act",
        "View by Section", "Download PDFs", "With annotations", "Without annotations",
        "On the eISB", "Revised Acts", "Previous Section", "Next Section",
        "Print Section", "Open PDF", "Print Full Act", "Amendments", "Leasuithe",
        "Statutory Instruments", "Ionstraimí Reachtúla",
    }
    lines = []
    for raw in root.get_text("\n").splitlines():
        line = raw.strip()
        if not line:
            if lines and lines[-1] != "":
                lines.append("")
            continue
        if line in skip or line.startswith(("《", "〈", "↗")):
            continue
        lines.append(line)
    body = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    sha = hashlib.sha256(html.encode("utf-8", "replace")).hexdigest()
    return (
        f"---\ntitle: \"{title}\"\ncitation: \"{citation}\"\n"
        f"source_url: \"{url}\"\nsource_type: legislation\njurisdiction: IE\n"
        f"conversion: official-html-plaintext\nsource_html_sha256: \"{sha}\"\n---\n\n"
        f"# {title}\n\n{body}\n"
    )


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    print(f"wrote {path} ({len(text)} bytes)")


def extract_vatca() -> None:
    out = ROOT / "vatca-2010-revised"
    for n in VATCA_SECTIONS:
        url = f"https://revisedacts.lawreform.ie/eli/2010/act/31/section/{n}/revised/en/html"
        raw = Path(f"/tmp/vatca/s{n}.html")
        if not raw.exists():
            fetch(url, raw)
            time.sleep(0.2)
        write(out / f"s{n:03d}.md", html_to_md(raw.read_text(errors="replace"), f"VATCA 2010 s.{n} (revised)", f"2010 Act 31 s.{n}", url))
    for n in VATCA_LETTERED:
        url = f"https://revisedacts.lawreform.ie/eli/2010/act/31/section/{n}/revised/en/html"
        raw = Path(f"/tmp/vatca/s{n}.html")
        try:
            if not raw.exists():
                fetch(url, raw)
                time.sleep(0.2)
            if raw.stat().st_size < 2000:
                continue
            write(out / f"s{n}.md", html_to_md(raw.read_text(errors="replace"), f"VATCA 2010 s.{n} (revised)", f"2010 Act 31 s.{n}", url))
        except Exception as e:
            print("skip", n, e)
    for n in (1, 2, 3):
        url = f"https://revisedacts.lawreform.ie/eli/2010/act/31/schedule/{n}/revised/en/html"
        raw = Path(f"/tmp/vatca/sch{n}.html")
        if not raw.exists():
            fetch(url, raw)
        write(out / f"schedule-{n}.md", html_to_md(raw.read_text(errors="replace"), f"VATCA 2010 Schedule {n} (revised)", f"2010 Act 31 Sch.{n}", url))


def extract_si639() -> None:
    url = "https://www.irishstatutebook.ie/eli/2010/si/639/made/en/print"
    raw = Path("/tmp/si639-print.html")
    if not raw.exists():
        fetch(url, raw)
    write(ROOT / "si-639-2010" / "2010-si-639.md", html_to_md(raw.read_text(errors="replace"), "Value-Added Tax Regulations 2010 (S.I. No. 639 of 2010)", "S.I. 639/2010", url))


def extract_tdm() -> None:
    import pdfplumber
    url = "https://www.revenue.ie/en/tax-professionals/tdm/income-tax-capital-gains-tax-corporation-tax/part-38/38-01-03b.pdf"
    raw = Path("/tmp/tdm-380103b.pdf")
    if not raw.exists():
        fetch(url, raw)
    pages = []
    with pdfplumber.open(raw) as pdf:
        for i, page in enumerate(pdf.pages, 1):
            pages.append(f"\n\n<!-- page {i} -->\n\n{page.extract_text() or ''}")
    sha = hashlib.sha256(raw.read_bytes()).hexdigest()
    write(ROOT / "tdm-38-01-03b" / "38-01-03b.md", f"""---
title: "TDM Part 38-01-03b — Guidelines for VAT Registration"
citation: "Revenue TDM Part 38-01-03b"
source_url: "{url}"
source_type: revenue_guidance
jurisdiction: IE
conversion: pdfplumber-text
source_pdf_sha256: "{sha}"
---

# Tax and Duty Manual Part 38-01-03b — Guidelines for VAT Registration
{''.join(pages)}
""")


def extract_rates() -> None:
    url = "https://www.revenue.ie/en/vat/vat-rates/search-vat-rates/current-vat-rates.aspx"
    raw = Path("/tmp/vat-rates.html")
    if not raw.exists():
        fetch(url, raw)
    soup = BeautifulSoup(raw.read_text(errors="replace"), "html.parser")
    table = soup.find("table")
    rows = []
    for tr in table.find_all("tr") if table else []:
        cells = [c.get_text(" ", strip=True) for c in tr.find_all(["th", "td"])]
        if cells:
            rows.append("| " + " | ".join(cells) + " |")
    body = "\n".join(rows) if rows else "_table missing_"
    write(ROOT / "vat-rates" / "current-vat-rates.md", f"""---
title: "Current VAT rates (Revenue)"
source_url: "{url}"
source_type: revenue_guidance
jurisdiction: IE
---

# Current VAT rates

{body}
""")


if __name__ == "__main__":
    extract_vatca()
    extract_si639()
    extract_tdm()
    extract_rates()
    print("done")
