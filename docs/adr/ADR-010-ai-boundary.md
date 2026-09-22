# ADR-010 — AI boundary

Status: Accepted · 2026-09-21

## Decision

Release 1 ships **no LLM dependency**. Search is a deterministic parser → `WorldQuery`. The architecture reserves one seam — `NaturalLanguageQueryAdapter` (text → WorldQuery, validated by `worldQuerySchema`) and `SummaryAdapter` (structured results → prose) — both optional, both schema-validated, neither able to create observations, decide identity, alter timestamps, invent severity or merge objects. Confidence and correlation are never LLM-assigned.
