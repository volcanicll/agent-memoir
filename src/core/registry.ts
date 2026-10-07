/**
 * Adapter registry.
 *
 * registry.json (repo root) is the community-facing registry file in the
 * `{version, plugins:[...]}` style used by ~/codespace/plugins/registry.json.
 * Builtin adapters are mapped by id to factories here; community entries may
 * carry a `module` field pointing at an importable adapter — Phase 0 lists
 * them but does not dynamically import untrusted code.
 */

import { readFileSync } from 'node:fs';
import type { Adapter } from './adapter.ts';
import type { EventSource } from './event.ts';
import { HermesAdapter } from '../adapters/hermes/index.ts';
import { ClaudeCodeAdapter } from '../adapters/claude-code/index.ts';
import { CodexAdapter } from '../adapters/codex/index.ts';

export interface RegistryEntry {
  id: EventSource;
  name: string;
  builtin?: boolean;
  sourceKind?: string;
  /** Glob or path hint shown by `init`; documentation only. */
  detect?: string;
  /** For community adapters: importable module id. Not loaded in Phase 0. */
  module?: string;
  summary?: { en?: string; zh?: string };
}

export interface RegistryFile {
  version: number;
  adapters: RegistryEntry[];
}

const BUILTIN_FACTORIES: Readonly<Record<string, () => Adapter>> = {
  hermes: () => new HermesAdapter(),
  'claude-code': () => new ClaudeCodeAdapter(),
  codex: () => new CodexAdapter(),
};

export class AdapterRegistry {
  private readonly byId = new Map<string, Adapter>();
  private entries: RegistryEntry[] = [];

  register(adapter: Adapter): void {
    if (this.byId.has(adapter.id)) {
      throw new Error(`adapter already registered: ${adapter.id}`);
    }
    this.byId.set(adapter.id, adapter);
  }

  /** Read registry.json and register every builtin adapter it declares. */
  loadFromRegistryFile(path?: string): RegistryFile {
    const file = readRegistryFile(path);
    this.entries = file.adapters;
    for (const entry of file.adapters) {
      if (entry.builtin && !this.byId.has(entry.id)) {
        const factory = BUILTIN_FACTORIES[entry.id];
        if (factory) this.register(factory());
      }
    }
    return file;
  }

  get(id: EventSource): Adapter | undefined {
    return this.byId.get(id);
  }

  list(): Adapter[] {
    return [...this.byId.values()];
  }

  listEntries(): RegistryEntry[] {
    return this.entries;
  }
}

export function readRegistryFile(path?: string): RegistryFile {
  const resolved = path ?? new URL('../../registry.json', import.meta.url).pathname;
  const raw = JSON.parse(readFileSync(resolved, 'utf8')) as RegistryFile;
  if (!raw || typeof raw.version !== 'number' || !Array.isArray(raw.adapters)) {
    throw new Error(`invalid registry file: ${resolved}`);
  }
  return raw;
}

/** Registry preloaded with the builtins declared in registry.json. */
export function defaultRegistry(path?: string): AdapterRegistry {
  const reg = new AdapterRegistry();
  reg.loadFromRegistryFile(path);
  return reg;
}
