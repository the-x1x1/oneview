# DuckDB/Parquet as the default history backend — plan (roadmap 0.4)

Status: **decided and built, 2026-10-05.** The operator chose to switch the app's default to
DuckDB/Parquet and to read the existing NDJSON history _beside_ it — neither converted nor
deleted (a third option to the two below). The app passes `historyBackend: 'duckdb-parquet'`
unless Settings → History → Storage says NDJSON (`history.backend`, read at start); the
runtime's own default stays NDJSON for tests and tools. `DuckDbParquetBackend` reads a
partition's `<provider>-<HHMM>.ndjson` (`LEGACY_NDJSON_EXT`) beside its Parquet and staging
files in every query, keeps it in the index and the size cap, deletes it with its partition
under retention, and moves its rows into Parquet only when a rewrite (dedupe, downsampling)
already reads the whole partition.

Laptop, 2026-10-05 (`b00788f`, the gate 16/16 with DuckDB loaded, `runtime started …
historyBackend: duckdb-parquet`): the first startup sweep moved 197 recently written
partitions into Parquet through its usual dedupe (86 MB), nothing else was converted. A scrub
took 3.2–3.8 s (satellites 2.0–2.1 s, earthquakes 0.3 s) against 2.2–2.9 s on NDJSON the same
day: most of the window is still NDJSON-era rows read line by line, the 700 MB of 2026-09-28/29
among them. They leave the seven-day window on 2026-10-06, and each day after that more of
the window is Parquet; the time is to be measured again then. An earlier build read each day
directory once per partition (earthquakes 2.2 s); `b00788f` reads it once per query.

## Why

A timeline scrub reads, per object type, the latest row of every object inside that type's
lookback (`HistoryStore.snapshotAt`). On NDJSON every row of every partition in the window is
read and parsed in JavaScript. On the test laptop on 2026-10-04 a scrub took **7.2–8.8 s**
(`historical projection slow`, 19,639 objects), almost all of it the satellites: 835 MB of
satellite rows inside their seven-day window (700 MB of them written on 2026-09-28/29, before
write-time dedupe). The DuckDB backend answers the same question in SQL over Parquet
(`row_number() OVER (PARTITION BY objectId ORDER BY observedAt DESC)`, `objectsAt` in
`duckdb-backend.ts`), reading only the columns it needs from a columnar file.

Since then (feature/next, 2026-10-05) the NDJSON read parses only the rows that can be the
answer, and the same scrub on the same laptop takes 2.2–2.9 s. That narrows the case for
switching now; DuckDB still reads a column instead of every byte of every line, so its lead
grows with the history.

## What already exists

- `DuckDbParquetBackend` implements the whole `HistoryBackend` interface, with the same
  directory layout (`history/<type>/<YYYY>/<MM>/<DD>/<provider>-<HHMM>.parquet`), appends
  through a `.staging.ndjson` rolled into Parquet every 5,000 rows or 60 s, immutable Parquet
  generations, and the same `index.json`.
- `createHistoryBackend` falls back to NDJSON when the native module cannot load and says why
  in Diagnostics.
- The installer carries the native module: `@duckdb/node-api` 1.4.5-r.1 is a dependency of
  `apps/desktop`, unpacked from the asar (`electron-builder.yml`).
- `pnpm test` runs the DuckDB backend's tests for real where the module is installed.

## What switching involves

1. **Existing history.** The DuckDB backend reads `.parquet` and `.staging.ndjson`; it does not
   read the NDJSON backend's `.ndjson` partitions. Switched as it is, the timeline would start
   empty and the old files would sit unread until the size cap deleted them. A conversion is
   needed: for each `.ndjson` partition, `COPY (SELECT … FROM read_ndjson(file)) TO
tmp.parquet`, compare the row count with the index, rename into place, update the index,
   and only then delete the `.ndjson`. Run in the background a partition at a time (newest
   first, so the timeline's recent past is fast first). While it runs, a partition is read
   from whichever file exists; a crash leaves either the old file or both, never neither.
   Temporary disk use is one partition's Parquet beside its NDJSON (the largest on the laptop
   is 78 MB).
2. **No network from the native module.** Done on feature/next (2026-10-04): the backend
   used to run `INSTALL <name>` when a `LOAD` failed, which downloads from DuckDB's extension
   server — outside the app's HTTP allowlist and its offline mode. It now only `LOAD`s
   extensions built into the Node bindings (`json`), switches `autoinstall_known_extensions`
   and `autoload_known_extensions` off on open, and writes Parquet without WKB geometry when
   `spatial` is not built in.
3. **Verification on the laptop.**
   - The gate with DuckDB as the default.
   - Diagnostics showing `duckdb-parquet`, not degraded.
   - The scrub time on the same history before and after (the `historical projection slow` line).
   - Retention, dedupe and the size cap on Parquet.
   - A clean-PC install, which needs the operator.
4. **A way back.** A setting (`history.backend`: `auto` | `ndjson`) so a problem on one
   machine can be answered without a new build. NDJSON keeps reading `.staging.ndjson` only
   if a reverse conversion exists, so "back" means the history recorded under DuckDB stays in
   Parquet unread. Say so in the setting's description.

## Decisions for the operator

- **Switch the default** to DuckDB/Parquet (with the NDJSON fallback kept), for 0.3.0 or later.
- **Convert the existing history** in place as described in step 1 (the `.ndjson` files are
  deleted after each verified conversion), or start Parquet history empty and let the NDJSON
  history age out under the size cap.
