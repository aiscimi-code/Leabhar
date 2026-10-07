#!/usr/bin/env python3
"""Convert articles of a EUR-Lex consolidated text to the plain text the
rules parsers read (issue #556). Each article as "Article N" then its text
runs, one per line, blank lines dropped; the consolidation's amendment
markers (the "▼M2" links) are left out, and typographic quotes are written
as the ASCII quotes the copy in docs/statutes/282-2011/ was made with, so a
ported excerpt says exactly what the copy said.

Called by scripts/catalogue/extract.ts, never at run time:

  python3 scripts/catalogue/eurlex_html_to_text.py <page.html> <article> [<article> ...]

Writes the text to standard output.
"""
from __future__ import annotations

import sys

try:
    from bs4 import BeautifulSoup
except ImportError as e:
    raise SystemExit("pip install beautifulsoup4") from e

QUOTES = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"'})


def articles_text(html: str, articles: list[str]) -> str:
    soup = BeautifulSoup(html, "html.parser")
    out: list[str] = []
    for article in articles:
        div = soup.find("div", id=f"art_{article}", class_="eli-subdivision")
        if div is None:
            raise SystemExit(f"no div#art_{article}: not on this EUR-Lex page")
        for tag in div.select("script, style, p.modref"):
            tag.decompose()
        lines = (line.strip() for line in div.get_text("\n").splitlines())
        out.extend(line.translate(QUOTES) for line in lines if line)
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    with open(sys.argv[1], encoding="utf-8") as f:
        sys.stdout.write(articles_text(f.read(), sys.argv[2:]))
