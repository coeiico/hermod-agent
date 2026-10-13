import { browserCommandAgent } from '@/ai/agents/interactive/browser_command/agent';
import type { ApprovalMode } from '@/ai/runtime/context';
import type { CacheTtl, Effort } from '@/ai/runtime/definition';

// Non-secret preferences. Safe for the popup and settings page to read and
// write directly. The API key vault lives under a separate storage key and is
// only touched by the background worker (see lib/keystore.ts).
export interface Settings {
  model: string;
  effort: Effort;
  cacheTtl: CacheTtl;
  /** When Hermod asks before acting. Picked in the popup, below the prompt. */
  approvalMode: ApprovalMode;
  /** True while the vault is encrypted with DEFAULT_PASSPHRASE. */
  usesDefaultPassphrase: boolean;
}

// The agent's config.yaml is the single source of the defaults.
const agentDefaults = browserCommandAgent.config;

export const DEFAULT_SETTINGS: Settings = {
  model: agentDefaults.model,
  effort: agentDefaults.effort,
  cacheTtl: agentDefaults.cache_ttl,
  approvalMode: 'auto',
  usesDefaultPassphrase: true,
};

export const APPROVAL_MODE_OPTIONS: { value: ApprovalMode; label: string; description: string }[] = [
  { value: 'ask', label: 'Ask first', description: 'Asks before every change it makes to your browser.' },
  { value: 'auto', label: 'Auto', description: 'Makes changes, and asks before risky ones, like closing a window or many tabs.' },
  { value: 'never', label: "Don't ask", description: "Just does it. Still asks before anything that can't be undone, like deleting bookmarks or history." },
];

const KEY = 'settings';

// Only what the user changed is stored, so a new default in config.yaml still
// reaches everyone who never picked their own.
async function getStored(): Promise<Partial<Settings>> {
  const stored = await browser.storage.local.get(KEY);
  return (stored[KEY] as Partial<Settings> | undefined) ?? {};
}

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await getStored()) };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const stored = { ...(await getStored()), ...patch };
  await browser.storage.local.set({ [KEY]: stored });
  return { ...DEFAULT_SETTINGS, ...stored };
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
