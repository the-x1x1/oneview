import type { WorldEvent, WorldObject } from '@worldview/world-model';
import type { DetailLevel, PresentationInput, PresentationResult, RenderingRule } from './presentation.js';
import { presentObjects } from './presentation.js';
import type { ViewState } from './contract.js';

/**
 * Presentation off the UI thread. `presentObjects` is pure, so the worker is a
 * message loop around it. The host talks to a `PresentationWorker`; the default is
 * in-thread. `PortPresentationWorker` + `servePresentation` implement the same
 * interface over any MessagePort-like pair (a Web Worker in the shell, a fake pair
 * in tests). Requests are numbered so a stale reply never overrides a newer one.
 */
export interface PresentationWorker {
  present(input: PresentationRequest): Promise<PresentationResult>;
  dispose(): void;
}

/** Structured-clone-safe subset of PresentationInput (arrays, not iterables). */
export interface PresentationRequest {
  objects: WorldObject[];
  events?: WorldEvent[];
  view: ViewState;
  rules?: RenderingRule[];
  visibleTypes?: string[];
  selectedId?: string | null;
  hoveredId?: string | null;
  selectedTrack?: Array<{ latitude: number; longitude: number; altitudeM?: number }>;
  maxFeatures?: number;
  detail?: DetailLevel;
}

export function toPresentationInput(req: PresentationRequest): PresentationInput {
  const input: PresentationInput = { objects: req.objects, view: req.view };
  if (req.events) input.events = req.events;
  if (req.rules) input.rules = req.rules;
  if (req.visibleTypes) input.visibleTypes = new Set(req.visibleTypes);
  if (req.selectedId !== undefined) input.selectedId = req.selectedId;
  if (req.hoveredId !== undefined) input.hoveredId = req.hoveredId;
  if (req.selectedTrack) input.selectedTrack = req.selectedTrack;
  if (req.maxFeatures !== undefined) input.maxFeatures = req.maxFeatures;
  if (req.detail !== undefined) input.detail = req.detail;
  return input;
}

export class InThreadPresentationWorker implements PresentationWorker {
  present(input: PresentationRequest): Promise<PresentationResult> {
    try {
      return Promise.resolve(presentObjects(toPresentationInput(input)));
    } catch (err) {
      return Promise.reject(err);
    }
  }
  dispose(): void {
    /* nothing to release */
  }
}

export type WorkerRequestMessage = { type: 'present'; seq: number; request: PresentationRequest };
export type WorkerResponseMessage =
  { type: 'result'; seq: number; result: PresentationResult } | { type: 'error'; seq: number; message: string };

export interface PortLike<Out, In> {
  postMessage(message: Out): void;
  onMessage(listener: (message: In) => void): () => void;
  close?(): void;
}

/** Host side: sends requests over a port and resolves replies by sequence number. */
export class PortPresentationWorker implements PresentationWorker {
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (r: PresentationResult) => void; reject: (e: Error) => void }
  >();
  private readonly unsubscribe: () => void;
  constructor(private readonly port: PortLike<WorkerRequestMessage, WorkerResponseMessage>) {
    this.unsubscribe = port.onMessage((msg) => {
      const p = this.pending.get(msg.seq);
      if (!p) return;
      this.pending.delete(msg.seq);
      if (msg.type === 'result') p.resolve(msg.result);
      else p.reject(new Error(msg.message));
    });
  }
  present(request: PresentationRequest): Promise<PresentationResult> {
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.port.postMessage({ type: 'present', seq, request });
    });
  }
  dispose(): void {
    this.unsubscribe();
    for (const p of this.pending.values()) p.reject(new Error('presentation worker disposed'));
    this.pending.clear();
    this.port.close?.();
  }
}

/** Worker side: serve presentation requests until the returned disposer is called. */
export function servePresentation(port: PortLike<WorkerResponseMessage, WorkerRequestMessage>): () => void {
  return port.onMessage((msg) => {
    if (msg.type !== 'present') return;
    try {
      port.postMessage({ type: 'result', seq: msg.seq, result: presentObjects(toPresentationInput(msg.request)) });
    } catch (err) {
      port.postMessage({ type: 'error', seq: msg.seq, message: err instanceof Error ? err.message : String(err) });
    }
  });
}
