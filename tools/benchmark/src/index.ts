import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runPresentationBenchmark, type BenchmarkOptions, type BenchmarkReport } from '@worldview/render-dense';

/**
 * Benchmark tool: runs the render-dense presentation harness and writes the
 * report as verification evidence. GPU frame-rate benchmarks (the 30 FPS
 * heavy-region target in ADR-008) require the desktop app on the operator
 * machine; this tool covers the CPU side that runs everywhere.
 */
export interface BenchmarkRunOptions extends BenchmarkOptions {
  outDir: string;
}

export function runAndWrite(options: BenchmarkRunOptions): { report: BenchmarkReport; file: string } {
  const report = runPresentationBenchmark(options);
  mkdirSync(options.outDir, { recursive: true });
  const file = path.join(options.outDir, 'presentation.json');
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  return { report, file };
}

export function formatSummary(report: BenchmarkReport): string {
  const lines = [`presentation benchmark (${report.node}, ${report.platform}, ${report.iterations} iterations)`, 'objects  band        present(ms) diff(ms)  features  clustered  density  obj/ms'];
  for (const c of report.cases) lines.push(`${String(c.objects).padStart(7)}  ${c.band.padEnd(11)} ${c.present.medianMs.toFixed(2).padStart(11)} ${c.diff.medianMs.toFixed(2).padStart(8)}  ${String(c.features).padStart(8)}  ${String(c.clustered).padStart(9)}  ${String(c.density).padStart(7)}  ${c.objectsPerMs.toFixed(0).padStart(6)}`);
  lines.push(`largest local-zoom set under one 60 FPS frame: ${report.frameBudgetObjectsLocal} objects; worker threshold recommendation: ${report.workerThresholdRecommendation}`);
  return lines.join('\n');
}
