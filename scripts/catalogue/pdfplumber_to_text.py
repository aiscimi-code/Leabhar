"""A Revenue PDF (a Tax and Duty Manual) as text, page by page (issue #556).

    python3 pdfplumber_to_text.py manual.pdf

Prints each page's text as pdfplumber extracts it, after a
"<!-- page N of M -->" marker, pages separated by four blank lines. This is
the `pdfplumber-full` conversion the statute copies of TDM 18-02-04, -05
and -11 were made with (verified byte for byte with pdfplumber 0.11.10), so
an excerpt taken from it says the same words. The rules catalogue extraction
(`scripts/catalogue/extract.ts`) runs it; the app never does.
"""
import sys

import pdfplumber


def convert(path: str) -> str:
    with pdfplumber.open(path) as pdf:
        total = len(pdf.pages)
        pages = [
            f"<!-- page {number} of {total} -->\n\n\n{page.extract_text() or ''}"
            for number, page in enumerate(pdf.pages, 1)
        ]
    return "\n\n\n\n\n".join(pages)


if __name__ == "__main__":
    sys.stdout.write(convert(sys.argv[1]))
