/**
 * @worldview/render-dense — the dense-layer abstraction (ADR-008): a
 * DenseLayerRenderer interface, the NativeDenseAdapter that delegates to the
 * active WorldRenderer, per-band feature budgets, and the presentation benchmark
 * harness that tools/benchmark runs to decide whether deck.gl is ever needed.
 */
export * from './dense.js';
export * from './benchmark.js';
