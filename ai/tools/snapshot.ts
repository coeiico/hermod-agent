// Builds the compact browser snapshot sent with every command: one line per
// tab grouped under its window. Cheap, always-relevant data only; heavy data
// (page text, history, bookmarks, downloads) is fetched through tools.
import { z } from 'zod';
import { defineTool } from '../runtime/tools';

export interface Snapshot {
  text: string;
  windows: number;
  tabs: number;
  displays: number;
}

type Tab = Browser.tabs.Tab;
type Window = Browser.windows.Window;

const LARGE_SESSION_TABS = 300;

/**
 * Vivaldi reports web panels as tabs. Their `vivExtData` JSON carries a
 * `panelId`; those must never be moved or closed. (Verified against the
 * field's documented shape; re-check if a Vivaldi update changes it.)
 */
export function isPanelTab(tab: Tab): boolean {
  const ext = (tab as Tab & { vivExtData?: string }).vivExtData;
  if (!ext) return false;
  try {
    const data = JSON.parse(ext) as { panelId?: unknown };
    return data.panelId !== undefined && data.panelId !== null;
  } catch {
    return false;
  }
}

export function relativeTime(ms: number | undefined, now = Date.now()): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function shortUrl(url: string | undefined, max: number): string {
  if (!url) return '';
  let u = url.replace(/^https:\/\//, '');
  if (u.length > max) {
    // Drop the query string and fragment first; they rarely identify a page.
    u = u.replace(/[?#].*$/, '');
  }
  return truncate(u, max);
}

function quote(title: string | undefined, max: number): string {
  return `"${truncate((title ?? '').replace(/\s+/g, ' ').trim(), max).replace(/"/g, "'")}"`;
}

function formatBounds(b: { width?: number; height?: number; left?: number; top?: number }): string {
  return `${b.width ?? '?'}x${b.height ?? '?'}@${b.left ?? '?'},${b.top ?? '?'}`;
}

function formatNow(now: Date): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const offset = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  const date = now.toLocaleDateString('en-CA'); // YYYY-MM-DD
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  return `${weekday} ${date} ${time} (${tz}, ${offset})`;
}

function tabLine(tab: Tab, compact: boolean, now: number): string {
  const flags: string[] = [];
  if (tab.active) flags.push('active');
  else if (tab.highlighted) flags.push('highlighted');
  if (tab.pinned) flags.push('pinned');
  if (tab.audible) flags.push('audible');
  if (tab.mutedInfo?.muted) flags.push('muted');
  if (tab.discarded) flags.push('discarded');
  if (tab.status === 'loading') flags.push('loading');
  if (!compact && tab.openerTabId !== undefined) flags.push(`opener=T${tab.openerTabId}`);

  const title = quote(tab.title, compact ? 40 : 80);
  const url = shortUrl(tab.pendingUrl ?? tab.url, compact ? 60 : 120);
  const accessed = compact ? '' : relativeTime((tab as Tab & { lastAccessed?: number }).lastAccessed, now);
  return [`  T${tab.id}`, `#${tab.index}`, ...flags, title, url, accessed].filter(Boolean).join(' ');
}

function windowLine(win: Window, tabCount: number): string {
  const parts = [`W${win.id}`];
  if (win.focused) parts.push('focused');
  parts.push(win.state ?? 'normal');
  if (win.type && win.type !== 'normal') parts.push(`type=${win.type}`);
  if (win.incognito) parts.push('incognito');
  parts.push(formatBounds(win));
  parts.push(`(${tabCount} tab${tabCount === 1 ? '' : 's'})`);
  return parts.join(' ');
}

async function displaysSection(): Promise<{ lines: string[]; count: number }> {
  try {
    const displays = await browser.system.display.getInfo();
    return {
      count: displays.length,
      lines: displays.map((d, i) => {
        const bits = [`  D${i}`, quote(d.name || `Display ${i + 1}`, 60)];
        if (d.isPrimary) bits.push('primary');
        bits.push(`bounds ${formatBounds(d.bounds)}`);
        bits.push(`workArea ${formatBounds(d.workArea)}`);
        return bits.join(' ');
      }),
    };
  } catch (err) {
    return { count: 0, lines: [`  (unavailable: ${(err as Error).message})`] };
  }
}

async function recentlyClosedSection(now: number): Promise<string[]> {
  try {
    const sessions = await browser.sessions.getRecentlyClosed({ maxResults: 10 });
    return sessions.map((s) => {
      const when = relativeTime(s.lastModified ? s.lastModified * 1000 : undefined, now);
      if (s.tab) {
        return `  session=${s.tab.sessionId} tab ${quote(s.tab.title, 80)} ${shortUrl(s.tab.url, 120)} ${when}`.trimEnd();
      }
      if (s.window) {
        const tabs = s.window.tabs ?? [];
        const first = tabs[0];
        return `  session=${s.window.sessionId} window (${tabs.length} tabs) first: ${quote(first?.title, 60)} ${when}`.trimEnd();
      }
      return '';
    }).filter(Boolean);
  } catch (err) {
    return [`  (unavailable: ${(err as Error).message})`];
  }
}

export async function buildSnapshot(): Promise<Snapshot> {
  const nowDate = new Date();
  const now = nowDate.getTime();

  const [windows, lastFocused, displays, closed] = await Promise.all([
    browser.windows.getAll({ populate: true, windowTypes: ['normal', 'popup', 'app'] }),
    browser.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined),
    displaysSection(),
    recentlyClosedSection(now),
  ]);

  const visibleTabs = (w: Window) => (w.tabs ?? []).filter((t) => !isPanelTab(t));
  const totalTabs = windows.reduce((n, w) => n + visibleTabs(w).length, 0);
  const compact = totalTabs > LARGE_SESSION_TABS;

  const focusedWindow = windows.find((w) => w.id === lastFocused?.id) ?? windows.find((w) => w.focused);
  const focusedTabs = focusedWindow ? visibleTabs(focusedWindow) : [];
  const activeTab = focusedTabs.find((t) => t.active);
  const highlighted = focusedTabs.filter((t) => t.highlighted).map((t) => `T${t.id}`);

  const lines: string[] = [];
  lines.push(`Now: ${formatNow(nowDate)}`);
  lines.push(
    `Focus: window ${focusedWindow ? `W${focusedWindow.id}` : 'none'}, active tab ${activeTab ? `T${activeTab.id}` : 'none'}, highlighted tabs ${highlighted.length ? highlighted.join(',') : 'none'}`,
  );
  lines.push('');
  lines.push(`Displays (${displays.count}):`);
  lines.push(...displays.lines);
  lines.push('');
  lines.push(
    `Windows (${windows.length}, ${totalTabs} tabs${compact ? '; large session, so lines are shortened and last-accessed times omitted' : ''}):`,
  );
  // Focused window first so "this window" is the first thing Claude reads.
  const ordered = [...windows].sort((a, b) => Number(b.id === focusedWindow?.id) - Number(a.id === focusedWindow?.id));
  for (const w of ordered) {
    const tabs = visibleTabs(w);
    lines.push(windowLine({ ...w, focused: w.id === focusedWindow?.id }, tabs.length));
    for (const t of tabs) lines.push(tabLine(t, compact, now));
  }
  lines.push('');
  lines.push(`Recently closed (${closed.length}):`);
  lines.push(...(closed.length ? closed : ['  (none)']));

  return {
    text: lines.join('\n'),
    windows: windows.length,
    tabs: totalTabs,
    displays: displays.count,
  };
}

export const refreshSnapshot = defineTool({
  name: 'refresh_snapshot',
  title: 'Refresh snapshot',
  effect: 'read',
  description: 'Get a fresh browser snapshot (same format as the one in the request). Use after actions if you need current IDs, positions or windows.',
  input: z.object({}),
  async run() {
    return (await buildSnapshot()).text;
  },
});
