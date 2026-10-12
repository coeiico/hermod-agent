import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { rpc } from '@/lib/rpc';
import { LockKeyholeOpenIcon } from 'lucide-react';
import { useState } from 'react';

export function UnlockDialog({
  open,
  onUnlocked,
  onCancel,
}: {
  open: boolean;
  onUnlocked: () => void;
  onCancel: () => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await rpc({ type: 'unlock', passphrase });
    setBusy(false);
    if (res.ok) {
      setPassphrase('');
      onUnlocked();
    } else {
      setError(res.error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-[360px]">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Unlock your API key</DialogTitle>
            <DialogDescription>
              Enter your passphrase. The key stays unlocked until Vivaldi closes or you press Lock.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            type="password"
            placeholder="Passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            aria-invalid={!!error}
          />
          {error && <p className="text-destructive text-sm">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !passphrase}>
              <LockKeyholeOpenIcon /> {busy ? 'Unlocking…' : 'Unlock'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
