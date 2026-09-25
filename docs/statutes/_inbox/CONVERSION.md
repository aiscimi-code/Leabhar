# Markdown conversion pass — 2026-09-25

Official originals (PDF / HTML) are preserved byte-for-byte beside every `.md`.

Method:
- PDF → `pdftotext -layout -enc UTF-8` (Poppler 24.02.0)
- HTML → BeautifulSoup plaintext (scripts/nav/footer stripped)
- Front-matter records `source_pdf_sha256` / `source_html_sha256`

This pass converted every remaining original that did not already have a sibling
Markdown file (69 files + postponed-accounting public page).
Earlier first-pass conversions (B VATCA, D Notes for Guidance, F SWCA, H CA 2014,
A SIs / Finance Act) were left as they were.

Collision: `C/postponed-accounting/postponed-accounting.pdf` owns
`postponed-accounting.md`. The public HTML page is
`postponed-accounting-page.md`.
