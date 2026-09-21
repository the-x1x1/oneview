# WorldView <version>

Release candidate — unsigned build. Windows SmartScreen will warn on first run
(`docs/releases/KNOWN-LIMITATIONS.md`).

## Assets

| File | What it is |
| --- | --- |
| `WorldView-Setup-<version>.exe` | NSIS installer (per-user, no admin) |
| `WorldView-Portable-<version>.zip` | unpacked build; run `WorldView.exe` from any folder |
| `SHA256SUMS.txt` | hashes of the artifacts above |
| `WorldView-<version>.sbom.json` | CycloneDX 1.5 software bill of materials |
| `verification-report.json` | tests, provider checklists, boundary/licence audits, what was not verified |
| `THIRD_PARTY_NOTICES.txt` | software and data notices |
| `latest.yml` | updater metadata |

Verify before installing:

```powershell
Get-FileHash .\WorldView-Setup-<version>.exe -Algorithm SHA256
# compare with SHA256SUMS.txt
```

## What changed

<!-- from CHANGELOG.md -->

## Known limitations

<!-- from docs/releases/KNOWN-LIMITATIONS.md -->
