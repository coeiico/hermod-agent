import { describe, expect, it } from 'vitest';
import { decryptVault, encryptSecret, WrongPassphraseError } from './vault';

describe('vault', () => {
  it('round-trips a secret and never stores it in the clear', async () => {
    const vault = await encryptSecret('sk-ant-example', 'correct horse');
    expect(JSON.stringify(vault)).not.toContain('sk-ant-example');
    expect(vault).toMatchObject({ v: 1, kdf: 'PBKDF2-SHA256', iterations: 600_000 });
    expect(await decryptVault(vault, 'correct horse')).toBe('sk-ant-example');
  });

  it('uses a fresh salt and IV on every save', async () => {
    const [a, b] = await Promise.all([encryptSecret('same', 'pass'), encryptSecret('same', 'pass')]);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
  });

  it('reports a wrong passphrase', async () => {
    const vault = await encryptSecret('secret', 'right');
    await expect(decryptVault(vault, 'wrong')).rejects.toBeInstanceOf(WrongPassphraseError);
  });
});
