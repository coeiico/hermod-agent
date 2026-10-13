// Tools that act on windows.
import { z } from 'zod';
import { defineTool } from '../runtime/tools';
import { describeTabs, getTabs, getWindow, id, plural, tabIds } from './resolve';
import { isPanelTab } from './snapshot';

const windowState = z.enum(['normal', 'minimized', 'maximized', 'fullscreen']);
const bounds = z
  .object({
    left: z.number().int().optional(),
    top: z.number().int().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .describe('Window position and size in screen pixels. Use display workArea values to place windows on a monitor.');

export const newWindowWithTabs = defineTool({
  name: 'new_window_with_tabs',
  title: 'New window with tabs',
  effect: 'write',
  description:
    'Create a new window containing the given existing tabs (moved, not copied), optionally positioned with bounds (for example on a specific display) and a state.',
  input: z.object({
    tabIds,
    state: windowState.optional(),
    bounds: bounds.optional(),
    focused: z.boolean().default(true),
  }),
  async run({ tabIds, state, bounds: b, focused }) {
    const tabs = await getTabs(tabIds);
    const [first, ...rest] = tabIds;
    const win = await browser.windows.create({ tabId: first, focused, ...(b ?? {}) });
    if (!win?.id) throw new Error('The browser did not return the new window.');
    if (rest.length) await browser.tabs.move(rest, { windowId: win.id, index: -1 });
    if (state && state !== 'normal') await browser.windows.update(win.id, { state });
    return `Created W${win.id} with ${plural(tabs.length, 'tab')} (${describeTabs(tabs)}).`;
  },
});

export const focusWindow = defineTool({
  name: 'focus_window',
  title: 'Focus window',
  effect: 'write',
  description: 'Bring a window to the front and focus it.',
  input: z.object({ windowId: id }),
  async run({ windowId }) {
    await getWindow(windowId);
    await browser.windows.update(windowId, { focused: true });
    return `Focused W${windowId}.`;
  },
});

export const setWindowState = defineTool({
  name: 'set_window_state',
  title: 'Resize window',
  effect: 'write',
  description:
    'Change a window state (normal, minimized, maximized, fullscreen) and/or its bounds. To put a window on another monitor, set bounds inside that display workArea; add state "maximized" to fill it.',
  input: z.object({
    windowId: id,
    state: windowState.optional(),
    bounds: bounds.optional(),
  }),
  async run({ windowId, state, bounds: b }) {
    if (!state && !b) throw new Error('Give a state, bounds, or both.');
    await getWindow(windowId);
    // Bounds only apply to a normal window, so set them first, then the state.
    if (b && Object.keys(b).length) {
      await browser.windows.update(windowId, { state: 'normal' });
      await browser.windows.update(windowId, { ...b });
    }
    if (state && (state !== 'normal' || !b)) await browser.windows.update(windowId, { state });
    const w = await browser.windows.get(windowId);
    return `W${windowId} is now ${w.state} at ${w.width}x${w.height}@${w.left},${w.top}.`;
  },
});

export const mergeWindows = defineTool({
  name: 'merge_windows',
  title: 'Merge windows',
  effect: 'write',
  description: 'Move every tab from the source windows into the target window (appended at the end). Source windows close once empty.',
  input: z.object({
    sourceWindowIds: z.array(id).min(1),
    targetWindowId: id,
  }),
  async run({ sourceWindowIds, targetWindowId }) {
    await getWindow(targetWindowId);
    let moved = 0;
    for (const sourceId of sourceWindowIds) {
      if (sourceId === targetWindowId) continue;
      const source = await getWindow(sourceId);
      const ids = (source.tabs ?? []).filter((t) => !isPanelTab(t) && t.id !== undefined).map((t) => t.id!);
      if (ids.length) await browser.tabs.move(ids, { windowId: targetWindowId, index: -1 });
      moved += ids.length;
    }
    return `Moved ${plural(moved, 'tab')} from ${sourceWindowIds.map((w) => `W${w}`).join(', ')} into W${targetWindowId}.`;
  },
});

export const closeWindow = defineTool({
  name: 'close_window',
  title: 'Close window',
  effect: 'destructive',
  description: 'Close a whole window and all its tabs. Depending on their settings, the user may be asked to confirm first.',
  input: z.object({ windowId: id }),
  async confirm({ windowId }) {
    const w = await getWindow(windowId);
    const tabs = (w.tabs ?? []).filter((t) => !isPanelTab(t));
    return `Close window W${windowId} and its ${plural(tabs.length, 'tab')}? ${describeTabs(tabs, 3)}`;
  },
  async run({ windowId }) {
    await getWindow(windowId);
    await browser.windows.remove(windowId);
    return `Closed W${windowId}.`;
  },
});
