import { DEFAULT_MODEL, type CacheTtl, type Effort } from './models';

// Non-secret preferences. Safe for the popup and settings page to read and
// write directly. The API key vault lives under a separate storage key and is
// only touched by the background worker (see lib/keystore.ts).
export interface Settings {
  model: string;
  effort: Effort;
  cacheTtl: CacheTtl;
  /** True while the vault is encrypted with DEFAULT_PASSPHRASE. */
  usesDefaultPassphrase: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  model: DEFAULT_MODEL,
  effort: 'low',
  cacheTtl: '5m',
  usesDefaultPassphrase: true,
};

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[KEY] as Partial<Settings> | undefined) };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && changes[KEY]) {
      cb({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue as Partial<Settings>) });
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
