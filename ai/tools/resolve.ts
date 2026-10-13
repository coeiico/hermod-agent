// Turning IDs the model wrote into real tabs and windows. This is the trust
// boundary for tool input: an ID that doesn't exist, or names a Vivaldi web
// panel, is refused here with an error the model can act on.
import { z } from 'zod';
import { isPanelTab } from './snapshot';

export type Tab = Browser.tabs.Tab;
export type Window = Browser.windows.Window;

export const id = z.number().int();
export const tabIds = z.array(id).min(1).describe('Tab IDs from the snapshot (the number after T).');

export async function getTabs(ids: number[]): Promise<Tab[]> {
  const unique = [...new Set(ids)];
  const results = await Promise.all(unique.map((i) => browser.tabs.get(i).catch(() => undefined)));
  const missing = unique.filter((_, i) => !results[i]);
  if (missing.length) {
    throw new Error(`No tab with ID ${missing.map((m) => `T${m}`).join(', ')}. Call refresh_snapshot to see current tabs.`);
  }
  const tabs = results as Tab[];
  const panels = tabs.filter(isPanelTab);
  if (panels.length) {
    throw new Error(`${panels.map((t) => `T${t.id}`).join(', ')} are Vivaldi web panels, not tabs, and can't be changed.`);
  }
  return tabs;
}

export async function getTab(tabId: number): Promise<Tab> {
  const [tab] = await getTabs([tabId]);
  return tab!;
}

export async function getWindow(windowId: number): Promise<Window> {
  try {
    return await browser.windows.get(windowId, { populate: true });
  } catch {
    throw new Error(`No window with ID W${windowId}. Call refresh_snapshot to see current windows.`);
  }
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** A short list of tab titles for results and confirmation questions. */
export function describeTabs(tabs: Tab[], max = 5): string {
  const shown = tabs.slice(0, max).map((t) => `"${(t.title ?? t.url ?? '').slice(0, 50)}"`);
  return shown.join(', ') + (tabs.length > max ? ` and ${tabs.length - max} more` : '');
}
