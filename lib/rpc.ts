// One-off request/response messages from the popup and settings page to the
// background worker. The worker is the only place the API key is decrypted
// or used; these messages carry passphrases in, never the key out.
import type { ThreadSummary } from './threads';

export type RpcRequest =
  | { type: 'status' }
  | { type: 'unlock'; passphrase: string }
  | { type: 'lock' }
  | { type: 'save-key'; apiKey: string; passphrase: string }
  | { type: 'change-passphrase'; oldPassphrase: string; newPassphrase: string }
  | { type: 'remove-key' }
  | { type: 'test-key'; passphrase?: string }
  | { type: 'list-threads' }
  /** `stale`: every thread not started today. Threads with a command running are kept. */
  | { type: 'clear-threads'; which: 'all' | 'stale' }
  | { type: 'pop-out' }
  | { type: 'reattach' };

export type RpcResponse =
  | {
      ok: true;
      hasVault?: boolean;
      unlocked?: boolean;
      usesDefaultPassphrase?: boolean;
      models?: string[];
      threads?: ThreadSummary[];
      /** For clear-threads: how many were deleted, and how many were kept because a command is running in them. */
      cleared?: number;
      keptRunning?: number;
    }
  | { ok: false; error: string };

export interface KeyStatus {
  hasVault: boolean;
  unlocked: boolean;
  usesDefaultPassphrase: boolean;
}

export async function rpc(request: RpcRequest): Promise<RpcResponse> {
  const res = (await browser.runtime.sendMessage(request)) as RpcResponse | undefined;
  // No answer means the worker doesn't handle this request: it is older than
  // the popup, which happens when a new build is loaded without reloading.
  if (!res) throw new Error(`The background worker did not answer "${request.type}". Reload Hermod on the browser's extensions page.`);
  return res;
}

export async function getKeyStatus(): Promise<KeyStatus> {
  const res = await rpc({ type: 'status' });
  if (!res.ok) throw new Error(res.error);
  return {
    hasVault: res.hasVault ?? false,
    unlocked: res.unlocked ?? false,
    usesDefaultPassphrase: res.usesDefaultPassphrase ?? true,
  };
}
