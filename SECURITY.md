# Security policy

Leabhar is a local-first accounting tool. It stores invoices, receipts
and bank statements, and it can optionally call an Anthropic API for
document extraction. Security matters here.

For a non-technical guide to whether the installer is safe to run and
how to verify that nothing leaves your machine, see
[docs/TRUST.md](docs/TRUST.md). This file is for reporting vulnerabilities.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security bug.** Report it
privately by email to **aiscimi@gmail.com**, with enough detail to
reproduce the problem. You will get an acknowledgement within a few
days and a fix timeline once the report is confirmed.

Please do not publish or exploit a confirmed vulnerability before a
fix is released. Coordinated disclosure is appreciated.

## Scope

This policy covers the Leabhar codebase in this repository. It does not
cover third-party dependencies — report those upstream — or any modified
or hosted version of Leabhar that someone else operates.

## Supported versions

Only the latest release receives security fixes. There is no
long-running maintenance of old branches.

## What Leabhar does and does not handle

- **Document storage is local-only.** Uploaded invoices and receipts
  live on the machine running Leabhar, under `DOCUMENT_STORAGE_PATH`.
  They are never sent anywhere unless you enable the `anthropic`
  extraction provider.
- **No secrets are required to run it.** `ANTHROPIC_API_KEY` is
  optional; with the default `local` extraction provider, nothing
  leaves the machine and no network call is made.
- **The database is a local SQLite file.** It is not exposed over the
  network by the application. If you put it on a network share, that is
  your threat model.
- **There is no user authentication beyond local access.** Leabhar is
  designed for a single user on localhost/LAN. Do not expose the dev
  server to the public internet without adding your own auth and TLS.

## What to include in a report

- A clear description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- The Leabhar version and your runtime (Node version, OS).
- Whether you had `EXTRACTION_PROVIDER` set to `anthropic` or `local`.
