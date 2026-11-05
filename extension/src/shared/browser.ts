// Firefox exposes promise-based `browser.*`; Chrome MV3 returns promises from
// `chrome.*`. Both share the same API surface for what we use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ext: typeof chrome = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof chrome;

import { DEFAULT_SETTINGS, type Settings } from './types';

export async function loadSettings(): Promise<Settings> {
  const stored = (await ext.storage.local.get('settings')) as { settings?: Partial<Settings> };
  return { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await ext.storage.local.set({ settings: next });
  return next;
}

/** Parse "민준 = Minjun" lines into a glossary object. */
export function parseGlossary(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(.+?)\s*(?:=|→|->|\t)\s*(.+)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

export function formatGlossary(g: Record<string, string>): string {
  return Object.entries(g)
    .map(([k, v]) => `${k} = ${v}`)
    .join('\n');
}
