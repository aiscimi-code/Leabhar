#!/usr/bin/env python3
"""Convert a revenue.ie page to the plain text the rules parsers read
(issue #556). The page's own content, one line per text run, blank lines
dropped: the conversion the VAT3 guidance copy in docs/statutes/vat3-rtd/
was made with, so a ported excerpt says exactly what the copy said.

Called by scripts/catalogue/extract.ts, never at run time:

  python3 scripts/catalogue/revenue_html_to_text.py <page.html>

Writes the text to standard output.
"""
from __future__ import annotations

import sys

try:
    from bs4 import BeautifulSoup
except ImportError as e:
    raise SystemExit("pip install beautifulsoup4") from e


def page_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    # The page's content: its heading, the article and the related-topics
    # column. The rest is the site's chrome.
    root = soup.select_one("div.hub-destination-pages")
    if root is None:
        raise SystemExit("no div.hub-destination-pages: not a revenue.ie content page")
    # The hub's index of sibling pages sits between the hub heading and the
    # article; it is navigation, not the page's words.
    for tag in root.select("script, style, noscript, div.hub-index"):
        tag.decompose()
    lines = (line.strip() for line in root.get_text("\n").splitlines())
    return "\n".join(line for line in lines if line) + "\n"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    with open(sys.argv[1], encoding="utf-8") as f:
        sys.stdout.write(page_text(f.read()))
