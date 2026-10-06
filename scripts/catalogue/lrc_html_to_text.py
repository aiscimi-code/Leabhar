#!/usr/bin/env python3
"""Convert an official revisedacts.lawreform.ie page to the plain text the
rules parsers read (issue #443). The conversion is the one the statute copies
in docs/statutes/ were made with (docs/statutes/scripts/extract_vat_sources.py),
so a ported excerpt says exactly what the copy said.

Called by scripts/catalogue/extract.ts, never at run time:

  python3 scripts/catalogue/lrc_html_to_text.py <page.html> <title> <citation> <url>

Writes the converted Markdown to standard output.
"""
from __future__ import annotations

import hashlib
import re
import sys

try:
    from bs4 import BeautifulSoup
except ImportError as e:
    raise SystemExit("pip install beautifulsoup4") from e


def html_to_md(html: str, title: str, citation: str, url: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.select("script, style, nav, header, footer, noscript, form"):
        tag.decompose()
    # revisedacts.lawreform.ie has no #content id; <main id="main-content">
    # wraps both the real provision and a leading <div class="act-nav">
    # breadcrumb ("Act as originally enacted" / "Next Section" etc.) that
    # the old #content/main/body fallback let straight through into the
    # flattened text. Selecting the actual provision container directly
    # excludes that chrome at the source rather than trying to filter its
    # text after the fact. Confirmed via two separate raw-HTML captures:
    # a Schedule page uses <section class="schedule" id="SCHED2">, but an
    # ordinary section page uses <section class="sect" id="SEC46"> — NOT
    # "section" as first assumed, which silently fell through to the
    # <main> fallback (chrome and all) for every individual section file
    # while Schedules came out clean from the same fix. "sect" caught late
    # precisely because nothing failed loudly: the fallback always
    # produces *some* output, just with the leading chrome still in it.
    # eISB as-enacted section pages put the provision in #act
    # (class="act-content"), not #content. Without this selector the
    # <main> fallback pulls in View-by-Section / Bill History chrome.
    root = (
        soup.select_one("#content") or soup.select_one("#act, div.act-content")
        or soup.select_one("section.sect, section.schedule")
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


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit(__doc__)
    path, title, citation, url = sys.argv[1:]
    with open(path, encoding="utf-8", errors="replace") as f:
        sys.stdout.write(html_to_md(f.read(), title, citation, url))
