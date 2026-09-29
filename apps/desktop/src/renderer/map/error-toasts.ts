/**
 * Which renderer problems get a toast. A map source that cannot load draws its failure once
 * per tile — a satellite layer with a bad request raised a toast for every tile in view, a
 * column of identical warnings covering the map. A toast is for telling someone *now*; one per
 * kind of problem says it. Every message still goes to the console and so to the app log.
 */

/** The same problem told apart from its tile address, frame time or request URL's path. */
export function errorToastKey(message: string): string {
  return message
    .replace(/(wv[a-z]+:\/\/[^%/:\s]+)\S*/gi, '$1')
    .replace(/https?:\/\/([^/\s]+)\S*/gi, '$1')
    .replace(/\d+/g, '#');
}

/** A per-kind cool-down: true when this message should toast now. */
export class ErrorToastGate {
  private readonly last = new Map<string, number>();
  constructor(private readonly quietMs = 5 * 60_000) {}
  allow(message: string, now: number): boolean {
    const key = errorToastKey(message);
    const at = this.last.get(key);
    if (at !== undefined && now - at < this.quietMs) return false;
    this.last.set(key, now);
    if (this.last.size > 200) this.last.delete(this.last.keys().next().value!);
    return true;
  }
}
