// Every browser tool, in a fixed order. The order is part of the prompt-cache
// prefix: append new tools at the end and never reorder.
import type { Tool } from '../runtime/tools';
import {
  controlDownloads,
  createBookmark,
  deleteBookmarks,
  deleteHistory,
  downloadFile,
  listBookmarks,
  listDownloads,
  moveBookmarks,
  restoreClosed,
  searchBookmarks,
  searchHistory,
  showDownload,
  sortBookmarks,
  updateBookmark,
} from './library';
import { getPageLinks, getPageText } from './pages';
import { refreshSnapshot } from './snapshot';
import {
  activateTab,
  closeTabs,
  copyTabs,
  discardTabs,
  duplicateTab,
  goBackOrForward,
  moveTabs,
  muteTabs,
  navigateTab,
  openTab,
  pinTabs,
  reloadTabs,
  sortTabs,
  zoomTabs,
} from './tabs';
import { closeWindow, focusWindow, mergeWindows, newWindowWithTabs, setWindowState } from './windows';

export const BROWSER_TOOLS: readonly Tool[] = [
  moveTabs,
  newWindowWithTabs,
  focusWindow,
  setWindowState,
  mergeWindows,
  activateTab,
  openTab,
  closeTabs,
  closeWindow,
  pinTabs,
  muteTabs,
  reloadTabs,
  duplicateTab,
  discardTabs,
  sortTabs,
  restoreClosed,
  searchBookmarks,
  createBookmark,
  searchHistory,
  getPageText,
  getPageLinks,
  listDownloads,
  refreshSnapshot,
  listBookmarks,
  updateBookmark,
  moveBookmarks,
  sortBookmarks,
  deleteBookmarks,
  navigateTab,
  goBackOrForward,
  zoomTabs,
  copyTabs,
  downloadFile,
  showDownload,
  controlDownloads,
  deleteHistory,
];

/** The UI label for a tool, falling back to its name. */
export function toolTitle(name: string): string {
  return BROWSER_TOOLS.find((t) => t.name === name)?.title ?? name;
}
