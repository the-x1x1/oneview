# Changelog fragments

A phase writes its CHANGELOG entry here as `<phase>.md` — Keep-a-Changelog bullets under
`### Added`, `### Changed`, `### Fixed`, in the voice of `CHANGELOG.md` (what the operator
can now do, and what it cost) — instead of editing `CHANGELOG.md`, which is the
integrator's. The integrator merges each fragment into `[Unreleased]` when the phase is
merged and deletes it in the same commit.
