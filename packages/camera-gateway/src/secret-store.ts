import type { SecretStore } from './types.js';

/** In-memory SecretStore for tests and browser-dev mode. Never persisted. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
  keys(): string[] {
    return [...this.values.keys()];
  }
}
