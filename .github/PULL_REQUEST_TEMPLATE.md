## Summary

<!-- One or two sentences: what does this change and why? -->

## Change type

- [ ] Bug fix
- [ ] New feature
- [ ] Accounting / financial logic
- [ ] Refactor
- [ ] Docs / tooling

## Accounting logic

If this touches any financial calculation (VAT, FX, invoices, journals,
P&L, balance sheet, period assignment, duplicate detection), describe
the deterministic test that proves it. **Financial logic needs a
deterministic test — never rely on an LLM for arithmetic.**

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] Tests added/updated for any accounting logic touched
- [ ] I have read and agree to [CLA.md](../CLA.md)
- [ ] Commits are signed off (`git commit -s`) affirming the DCO
