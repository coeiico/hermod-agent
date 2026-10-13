// The pages a web task works in: its own window, plus any tab its brief named.
// A task may act only inside its scope, and while it runs no other run may
// touch the scope's tabs or window (resolve.ts refuses them).
import type { RunContext } from '../runtime/context';
import type { ToolRunContext } from '../runtime/tools';

type Tab = Browser.tabs.Tab;

// A normal window big enough for sites to show their desktop layout.
const TASK_WINDOW = { width: 1280, height: 860 };

export class TaskScope {
  /** The task's own window, once it has one. */
  windowId: number | undefined;
  /** Tabs outside its window that it may use: the tab its brief named, and tabs those opened. */
  readonly tabIds = new Set<number>();
  /** Tabs it opened, which it may close. */
  readonly opened = new Set<number>();

  /** `label` names the task to other runs, as in "in use by web task K1". */
  constructor(readonly label: string) {}

  contains(tab: Tab): boolean {
    if (tab.id === undefined) return false;
    return tab.windowId === this.windowId || this.tabIds.has(tab.id) || (tab.openerTabId !== undefined && this.tabIds.has(tab.openerTabId));
  }
}

const scopes = new WeakMap<RunContext, TaskScope>();
const active = new Set<TaskScope>();

/** Gives a run its scope and claims it from other runs, until released. */
export function bindScope(run: RunContext, scope: TaskScope): void {
  scopes.set(run, scope);
  active.add(scope);
}

export function releaseScope(scope: TaskScope): void {
  active.delete(scope);
}

/** The running task whose scope holds this tab, if any. */
export function claimOf(tab: Tab): TaskScope | undefined {
  for (const scope of active) if (scope.contains(tab)) return scope;
  return undefined;
}

/** The running task whose window this is, if any. */
export function claimedWindow(windowId: number): TaskScope | undefined {
  for (const scope of active) if (scope.windowId === windowId) return scope;
  return undefined;
}

/** The calling web task's scope. */
export function scopeFor(ctx: ToolRunContext): TaskScope {
  const scope = scopes.get(ctx.run);
  if (!scope) throw new Error('This tool only works inside a web task.');
  return scope;
}

/** A tab the calling web task may act on. The trust boundary for page tools. */
export async function scopedTab(tabId: number, ctx: ToolRunContext): Promise<Tab> {
  const scope = scopeFor(ctx);
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab) throw new Error(`No tab T${tabId}. Call list_pages to see your pages.`);
  if (!scope.contains(tab)) throw new Error(`T${tabId} is not one of this task's pages. Work only in the pages list_pages shows.`);
  // A page the task's own pages opened (a link with target=_blank) joins the scope.
  if (tab.windowId !== scope.windowId) scope.tabIds.add(tabId);
  return tab;
}

/** Every tab the calling web task may act on. */
export async function scopedTabs(ctx: ToolRunContext): Promise<Tab[]> {
  const scope = scopeFor(ctx);
  return (await browser.tabs.query({})).filter((t) => scope.contains(t));
}

/**
 * Opens a URL in the task's own window, creating the window (behind the
 * user's) on first use. The user's window keeps focus.
 */
export async function openInScope(scope: TaskScope, url: string): Promise<Tab> {
  if (scope.windowId !== undefined) {
    const window = await browser.windows.get(scope.windowId).catch(() => undefined);
    if (window) {
      const tab = await browser.tabs.create({ windowId: scope.windowId, url, active: true });
      if (tab.id !== undefined) scope.opened.add(tab.id);
      return tab;
    }
    scope.windowId = undefined;
  }
  const previous = await browser.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  const created = await browser.windows.create({ url, focused: false, type: 'normal', ...TASK_WINDOW });
  const tab = created?.tabs?.[0];
  if (!created?.id || tab?.id === undefined) throw new Error('Could not open a window for the web task.');
  scope.windowId = created.id;
  scope.opened.add(tab.id);
  // Some browsers focus a new window even when asked not to; give focus back.
  const now = await browser.windows.get(created.id).catch(() => undefined);
  if (now?.focused && previous?.id !== undefined) await browser.windows.update(previous.id, { focused: true }).catch(() => {});
  return tab;
}
