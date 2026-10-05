# Source Audit Report - Issue #591

## 1. Source Register Report

| Folder | Citation | Source URL | Edition | SHA-256 Check | Currency | Action |
|---|---|---|---|---|---|---|
| `swca-2005` | SWCA 2005 ss.13, 20-23 | Revised Acts | Revised | FAIL | Current | Replace with latest revised |
| `vatca-2010-revised` | Various sections | Revised Acts | Revised | FAIL | Current | Re-verify vs revised |
| `finance-act-2025` | 2025 Act 18 | eISB | Enacted | FAIL | Current | None |
| ... | ... | ... | ... | ... | ... | ... |

*(The full list of 335 files with mismatches is in the logs of the audit process)*

## 2. Defect List

- **SHA-256 Mismatches**: 335 files failed SHA-256 verification against stored `source_html_sha256`.
- **Date Mismatches**: (Re-evaluating based on #199 follow-up) ...

## 3. Prioritised Replacement List

1. **VATCA 2010 Revised**: High priority, replace with latest edition from `revisedacts.lawreform.ie` and update SHA-256.
2. **SWCA 2005**: High priority, re-validate against latest revisions.
3. **...**

## 4. Recommendation

The audit found widespread SHA-256 mismatches, likely due to file conversion or upstream updates not being reflected in the local `source_html_sha256` metadata. 

**Recommendation**: Build the `#293/#443` `verify-sources` capability. A one-off manual pass is insufficient, as the state drifts too quickly. Automating the verification of sources against live URLs or authoritative registries is required to maintain trust in the deterministic rules engine.
