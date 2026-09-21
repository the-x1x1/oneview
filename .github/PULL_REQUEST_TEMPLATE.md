## Summary

<!-- What changed, in one or two sentences. -->

## Motivation

<!-- Why this change is needed. Link the issue or the directive section. -->

## Architecture impact

<!-- Contracts touched (world-model, provider-sdk, render-core, ipc-contract)? New package?
     Dependency direction respected (pnpm boundary-check)? ADR added or amended? -->

## Files / packages affected

## Provider & data licensing impact

<!-- New or changed provider? Data policy and config/licenses/providers.json record updated?
     Does anything new get cached, retained, exported or put into a worldpack? -->

## Security impact

<!-- New IPC channel, network host, file path, sidecar, credential or permission?
     Threat-model entry updated (docs/security/THREAT-MODEL.md)? -->

## Tests

<!-- Which groups: unit / contract / integration / offline / failure. Paste the counts. -->

```
pnpm typecheck && pnpm boundary-check && pnpm test && pnpm provider:test --all
```

## Manual QA

<!-- What you exercised by hand, on which platform. -->

## Screenshots

<!-- For UI changes. Omit the section if there are none; never paste a mock-up as evidence. -->

## Known limitations

## Rollback plan

<!-- How to revert safely: single commit? data migration? settings/schema change? -->
