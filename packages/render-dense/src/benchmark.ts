import type { WorldObject } from '@worldview/world-model';
import { diffFeatures, presentObjects, type PresentationResult, type RenderFeature, type ViewState } from '@worldview/render-core';

/**
 * Presentation benchmark harness (pure, runnable in Node): measures the cost of
 * `presentObjects` + `diffFeatures` at 1k/10k/50k/100k synthetic objects across
 * the LOD bands. `tools/benchmark` runs it and writes
 * artifacts/verification/benchmarks/presentation.json. GPU frame timing needs the
 * operator machine (see docs/architecture/RENDERING.md); this harness bounds the
 * CPU side of the pipeline, which is what decides the worker threshold and the
 * dense budget.
 */
export interface BenchmarkOptions {
  sizes?: number[];
  iterations?: number;
  now?: () => number;
  seed?: number;
}

export interface TimingSummary { medianMs: number; minMs: number; maxMs: number; meanMs: number }

export interface BenchmarkCase {
  objects: number;
  band: 'global' | 'regional' | 'local';
  zoom: number;
  present: TimingSummary;
  /** Diff of a second pass where 10% of objects moved. */
  diff: TimingSummary;
  features: number;
  clustered: number;
  density: number;
  changedFeatures: number;
  /** Objects presented per millisecond (median). */
  objectsPerMs: number;
}

export interface BenchmarkReport {
  ranAt: string;
  node: string;
  platform: string;
  iterations: number;
  cases: BenchmarkCase[];
  /** Largest object count whose in-thread median stays under one 60 FPS frame (16.7 ms) at local zoom. */
  frameBudgetObjectsLocal: number;
  workerThresholdRecommendation: number;
}

/** Deterministic PRNG (mulberry32) so runs are comparable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = ['aircraft', 'vessel', 'earthquake', 'fire-detection', 'satellite', 'weather-station', 'infrastructure'] as const;

export function syntheticObjects(count: number, seed = 1): WorldObject[] {
  const rnd = mulberry32(seed);
  const out: WorldObject[] = [];
  for (let i = 0; i < count; i++) {
    const type = TYPES[i % TYPES.length]!;
    // Clustered around a few hubs so clustering/density paths are exercised.
    const hub = i % 7;
    const lat = (rnd() - 0.5) * 8 + [37.7, 51.5, 35.7, -33.9, 40.7, 1.3, 55.7][hub]!;
    const lon = (rnd() - 0.5) * 8 + [-122.4, -0.1, 139.7, 151.2, -74.0, 103.8, 37.6][hub]!;
    const obj: WorldObject = {
      id: `${type}:bench:${i}`,
      type,
      sourceRefs: [],
      position: { latitude: lat, longitude: lon, ...(type === 'aircraft' ? { altitudeM: 9000 + rnd() * 3000 } : {}) },
      observedAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
      freshness: rnd() < 0.8 ? 'LIVE' : 'STALE',
      confidence: 0.9,
      labels: { name: `B${i}` },
      properties: { magnitude: 2 + rnd() * 6, depthKm: rnd() * 400 },
      provenance: { providerId: 'bench', sourceName: 'bench', origin: 'live', receivedAt: '2026-09-21T00:00:00.000Z' },
    };
    if (type === 'aircraft' || type === 'vessel') obj.motion = { headingDegrees: rnd() * 360 };
    out.push(obj);
  }
  return out;
}

function summarize(samples: number[]): TimingSummary {
  const s = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const medianMs = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return { medianMs: round(medianMs), minMs: round(s[0]!), maxMs: round(s[s.length - 1]!), meanMs: round(s.reduce((a, b) => a + b, 0) / s.length) };
}
const round = (x: number) => Math.round(x * 1000) / 1000;

const VIEWS: Array<{ band: BenchmarkCase['band']; view: ViewState }> = [
  { band: 'global', view: { center: { latitude: 20, longitude: 0 }, altitudeM: 20_000_000, zoom: 1.5, headingDegrees: 0, pitchDegrees: -90, bounds: { west: -180, south: -90, east: 180, north: 90 } } },
  { band: 'regional', view: { center: { latitude: 37.7, longitude: -122.4 }, altitudeM: 400_000, zoom: 7, headingDegrees: 0, pitchDegrees: -90, bounds: { west: -130, south: 30, east: -115, north: 45 } } },
  { band: 'local', view: { center: { latitude: 37.7, longitude: -122.4 }, altitudeM: 8_000, zoom: 12, headingDegrees: 0, pitchDegrees: -90, bounds: { west: -126.5, south: 33.7, east: -118.3, north: 41.7 } } },
];

export function runPresentationBenchmark(options: BenchmarkOptions = {}): BenchmarkReport {
  const sizes = options.sizes ?? [1_000, 10_000, 50_000, 100_000];
  const iterations = options.iterations ?? 5;
  const now = options.now ?? (() => performance.now());
  const cases: BenchmarkCase[] = [];
  for (const size of sizes) {
    const objects = syntheticObjects(size, options.seed ?? 1);
    const moved = objects.map((o, i) => (i % 10 === 0 && o.position ? { ...o, position: { ...o.position, latitude: o.position.latitude + 0.01 } } : o));
    for (const { band, view } of VIEWS) {
      const presentSamples: number[] = [];
      const diffSamples: number[] = [];
      let result: PresentationResult | undefined;
      let changed = 0;
      for (let i = 0; i < iterations; i++) {
        const t0 = now();
        result = presentObjects({ objects, view });
        presentSamples.push(now() - t0);
        const previous = new Map<string, RenderFeature>(result.upsert.map((f) => [f.id, f]));
        const t1 = now();
        const next = presentObjects({ objects: moved, view });
        const d = diffFeatures(previous, next.upsert);
        diffSamples.push(now() - t1);
        changed = d.upsert.length + d.remove.length;
      }
      const present = summarize(presentSamples);
      cases.push({ objects: size, band, zoom: view.zoom, present, diff: summarize(diffSamples), features: result!.stats.features, clustered: result!.stats.clustered, density: result!.stats.density, changedFeatures: changed, objectsPerMs: round(size / Math.max(0.001, present.medianMs)) });
    }
  }
  const local = cases.filter((c) => c.band === 'local' && c.present.medianMs <= 16.7).map((c) => c.objects);
  const frameBudgetObjectsLocal = local.length ? Math.max(...local) : 0;
  return {
    ranAt: new Date().toISOString(),
    node: typeof process !== 'undefined' ? process.version : 'unknown',
    platform: typeof process !== 'undefined' ? `${process.platform}-${process.arch}` : 'unknown',
    iterations,
    cases,
    frameBudgetObjectsLocal,
    // Keep the in-thread path under a quarter frame so input stays responsive; never below 1k.
    workerThresholdRecommendation: Math.max(1_000, Math.min(5_000, Math.floor(frameBudgetObjectsLocal / 4 / 1000) * 1000 || 1_000)),
  };
}
