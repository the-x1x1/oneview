# Phase `stac` — STAC catalogues and item search

Status: open · Branch: `phase/stac` · Target: 0.2.0 · Owner: (unassigned)

## Goal

Satellite and aerial imagery footprints — what was captured where and when — from any
STAC API (Earth Search, Planetary Computer, USGS Landsat, national catalogues) as objects
in the world: a footprint, a time, a collection, a thumbnail link, the asset list. Not the
imagery itself (that is an overlay, later).

## Read first

[PARALLEL-PHASES.md](../PARALLEL-PHASES.md); ADR-013; `docs/connectors/REST-JSON.md`;
STAC API spec 1.0 (core, item-search, `POST /search` with `bbox`, `datetime`,
`collections`, `limit`, pagination via `links[rel=next]` incl. POST bodies);
[TERRIAJS-HARVEST.md](../../architecture/TERRIAJS-HARVEST.md).

## Scope

In: `stac` — item search (`POST /search`, falling back to `GET /search`), `bbox` from the
viewport when `boundsQuery`, `datetime` as a rolling window setting (`last 7 days` by
default), `collections` from the definition, `next` link paging (GET links on the origin;
POST `next` with `body`/`merge` per the spec), items → observations: `id`, `datetime` (or
`start_datetime`), `geometry` (footprint kept as `mapping.geometry`, position = centroid of
the bbox), `collection`, `properties.platform`, `eo:cloud_cover`, `gsd`, the `thumbnail`
asset href and the asset keys as payload; static catalogues (`catalog.json` → `child` /
`item` links) walked to a depth cap.

Out: downloading assets; rendering imagery; COG/tiling; authenticated catalogues beyond a
bearer or query token.

## Deliverables

1. `packages/connector-runtime/src/connectors/stac/{search,static,items}.ts`, `index.ts`;
   slot lines.
2. Examples with sidecars and fixtures under `connectors/examples/stac/`,
   `fixtures/connectors/stac/`: Earth Search (Sentinel-2 L2A) and one static catalogue;
   fixtures for POST-next paging and a 4-corner bbox crossing the antimeridian.
3. `docs/connectors/stac.md`.
4. `stac.test.ts`: suite; paging; centroid; datetime window; static walk depth cap.
5. Changelog fragment; status and evidence.

## Definition of done

- [ ] `connector:test --all` green; `--live` pasted for Earth Search
- [ ] object type decision recorded (below) and applied consistently
- [ ] `phase-check` passes; all common checks green

## Design notes

- Object type: no `imagery-scene` exists. Until the amendment lands, map items to `place`
  with `payload.kind = "imagery-scene"` and make the presentation registry's handling of it
  a note in the brief; the amendment adds the type with an icon and a context section.
- Footprints are often huge multipolygons (Landsat WRS scenes); keep `geometry` but cap
  vertices (simplify or reject over 5,000 with a reason) so the renderer's line layer is
  not flooded.
- `datetime` may be `null` with `start_datetime`/`end_datetime`; use the start.
- Rate: catalogues are heavy; default `intervalSeconds` 900 and `limit` 100, `maxPages` 5.

## Amendment requests

- **ADR-002:** `ObjectTypes.ImageryScene = 'imagery-scene'` with presentation (icon,
  footprint drawing, context section showing collection, time, cloud cover, thumbnail).

## Evidence

(filled in at the end)
