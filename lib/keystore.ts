// Background-worker only. The encrypted vault lives in storage.local; the
// decrypted key lives only in storage.session (memory, cleared when the
// browser closes). The plain key is never written to storage.local, never
// logged, and never sent to content scripts.
import { decryptVault, encryptSecret, type Vault } from './vault';

const VAULT_KEY = 'apiKeyVault';
const SESSION_KEY = 'unlockedApiKey';

export async function initKeystore(): Promise<void> {
  // Default is already TRUSTED_CONTEXTS (extension pages only, no content
  // scripts); set it explicitly so a future change can't widen it by accident.
  await browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

async function getVault(): Promise<Vault | undefined> {
  const stored = await browser.storage.local.get(VAULT_KEY);
  return stored[VAULT_KEY] as Vault | undefined;
}

export async function hasVault(): Promise<boolean> {
  return (await getVault()) !== undefined;
}

export async function getUnlockedKey(): Promise<string | undefined> {
  const stored = await browser.storage.session.get(SESSION_KEY);
  return stored[SESSION_KEY] as string | undefined;
}

export async function saveKey(apiKey: string, passphrase: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error('Paste an API key first.');
  if (!passphrase) throw new Error('Passphrase cannot be empty.');
  const vault = await encryptSecret(trimmed, passphrase);
  await browser.storage.local.set({ [VAULT_KEY]: vault });
  await browser.storage.session.set({ [SESSION_KEY]: trimmed });
}

/** Decrypts with the passphrase. Throws WrongPassphraseError on a bad passphrase. */
export async function decryptWith(passphrase: string): Promise<string> {
  const vault = await getVault();
  if (!vault) throw new Error('No API key saved yet. Add one in Settings.');
  return decryptVault(vault, passphrase);
}

export async function unlock(passphrase: string): Promise<void> {
  const apiKey = await decryptWith(passphrase);
  await browser.storage.session.set({ [SESSION_KEY]: apiKey });
}

export async function lock(): Promise<void> {
  await browser.storage.session.remove(SESSION_KEY);
}

export async function changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
  if (!newPassphrase) throw new Error('New passphrase cannot be empty.');
  const apiKey = await decryptWith(oldPassphrase);
  await saveKey(apiKey, newPassphrase);
}

export async function removeKey(): Promise<void> {
  await browser.storage.local.remove(VAULT_KEY);
  await lock();
}
