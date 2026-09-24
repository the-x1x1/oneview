/**
 * `pnpm basemap:build --region <preset|bbox> --out <dir>` — the entry point the integrator
 * wires for phase `offline-basemaps` (integrator item #11: the root script, this package and
 * its lockfile importer). The phase owns `tools/basemap/**` and replaces this file with the
 * builder: Planetiler detected (never downloaded), run on an OSM extract the operator
 * provides, a PMTiles file with the Protomaps schema, and the pack entry with its
 * attribution. Until then it says so and exits 2 — it does not pretend to build anything.
 */
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: pnpm basemap:build --region <preset|west,south,east,north> --out <dir>');
  console.log('The builder is phase offline-basemaps; see docs/roadmap/phases/offline-basemaps.md.');
  process.exit(0);
}
console.error('basemap:build is not built yet (phase offline-basemaps); nothing was done.');
process.exit(2);
