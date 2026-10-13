import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { EFFORT_OPTIONS, MODELS } from '@/ai/models';
import type { CacheTtl, Effort } from '@/ai/runtime/definition';
import { getKeyStatus, rpc, type KeyStatus } from '@/lib/rpc';
import { APPROVAL_MODE_OPTIONS, DEFAULT_SETTINGS, getSettings, onSettingsChanged, updateSettings, type Settings } from '@/lib/settings';
import type { ThreadSummary } from '@/lib/threads';
import { OPEN_COMMAND, POPUP_COMMAND } from '@/lib/detached-window';
import { DEFAULT_PASSPHRASE } from '@/lib/vault';
import { AlertTriangleIcon, CheckCircle2Icon, KeyRoundIcon, LockIcon, LockOpenIcon, XCircleIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

type Feedback = { ok: boolean; text: string } | null;

function FeedbackLine({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return (
    <p className={`flex items-center gap-1.5 text-sm ${feedback.ok ? 'text-sage-ink' : 'text-bad-ink'}`}>
      {feedback.ok ? <CheckCircle2Icon className="size-3.5" /> : <XCircleIcon className="size-3.5" />}
      {feedback.text}
    </p>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-ink-3 text-xs">{hint}</p>}
    </div>
  );
}

function KeyCard({ status, refresh }: { status: KeyStatus; refresh: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [passphrase, setPassphrase] = useState(DEFAULT_PASSPHRASE);
  const [saveFeedback, setSaveFeedback] = useState<Feedback>(null);
  const [testFeedback, setTestFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('save');
    const res = await rpc({ type: 'save-key', apiKey, passphrase });
    setBusy(null);
    setSaveFeedback(res.ok ? { ok: true, text: 'Saved and unlocked.' } : { ok: false, text: res.error });
    if (res.ok) setApiKey('');
    refresh();
  };

  const test = async () => {
    setBusy('test');
    setTestFeedback(null);
    const res = await rpc({ type: 'test-key', passphrase: status.unlocked ? undefined : passphrase });
    setBusy(null);
    setTestFeedback(
      res.ok
        ? { ok: true, text: `OK. The key works (${res.models?.length ?? 0} models visible).` }
        : { ok: false, text: res.error },
    );
  };

  const toggleLock = async () => {
    if (status.unlocked) {
      await rpc({ type: 'lock' });
      setTestFeedback(null);
    } else {
      setBusy('unlock');
      const res = await rpc({ type: 'unlock', passphrase });
      setBusy(null);
      setTestFeedback(res.ok ? { ok: true, text: 'Unlocked.' } : { ok: false, text: res.error });
    }
    refresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRoundIcon className="size-3.5 text-ink-3" /> API key
          {status.hasVault ? (
            <Badge variant={status.unlocked ? 'success' : 'secondary'}>
              {status.unlocked ? <LockOpenIcon /> : <LockIcon />}
              {status.unlocked ? 'Saved · unlocked' : 'Saved · locked'}
            </Badge>
          ) : (
            <Badge variant="outline">Not set</Badge>
          )}
        </CardTitle>
        <CardDescription>
          A Claude Console API key (pay-as-you-go, separate from a Claude Pro or Max subscription). It's encrypted with your
          passphrase (PBKDF2 + AES-GCM) and stored only in this browser. The unlocked key is kept in memory until the browser
          closes or you lock it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid gap-3">
          <Field id="api-key" label={status.hasVault ? 'Replace API key' : 'API key'}>
            <Input
              id="api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
          <Field
            id="passphrase"
            label="Passphrase"
            hint={`Used to encrypt the key on save, and to unlock or test it while locked. Prefilled with the default "${DEFAULT_PASSPHRASE}".`}
          >
            <Input id="passphrase" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!apiKey.trim() || !passphrase || busy !== null}>
              {busy === 'save' ? 'Encrypting…' : 'Save key'}
            </Button>
            <Button type="button" variant="outline" onClick={test} disabled={!status.hasVault || busy !== null}>
              {busy === 'test' ? 'Testing…' : 'Test key'}
            </Button>
            {status.hasVault && (
              <Button type="button" variant="outline" onClick={toggleLock} disabled={busy !== null}>
                {status.unlocked ? <LockIcon /> : <LockOpenIcon />}
                {status.unlocked ? 'Lock' : busy === 'unlock' ? 'Unlocking…' : 'Unlock'}
              </Button>
            )}
          </div>
          <FeedbackLine feedback={saveFeedback} />
          <FeedbackLine feedback={testFeedback} />
        </form>
      </CardContent>
      {status.hasVault && (
        <CardFooter className="flex flex-col items-stretch gap-5 border-t pt-6">
          <ChangePassphrase refresh={refresh} />
          <Separator />
          <RemoveKey refresh={refresh} />
        </CardFooter>
      )}
    </Card>
  );
}

function ChangePassphrase({ refresh }: { refresh: () => void }) {
  const [oldPass, setOldPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPass !== confirm) {
      setFeedback({ ok: false, text: "The new passphrases don't match." });
      return;
    }
    setBusy(true);
    const res = await rpc({ type: 'change-passphrase', oldPassphrase: oldPass, newPassphrase: newPass });
    setBusy(false);
    setFeedback(res.ok ? { ok: true, text: 'Passphrase changed.' } : { ok: false, text: res.error });
    if (res.ok) {
      setOldPass('');
      setNewPass('');
      setConfirm('');
    }
    refresh();
  };

  return (
    <form onSubmit={submit} className="grid gap-3">
      <h3 className="font-medium text-base">Change passphrase</h3>
      <div className="grid gap-2 sm:grid-cols-3">
        <Input type="password" placeholder="Current passphrase" value={oldPass} onChange={(e) => setOldPass(e.target.value)} />
        <Input type="password" placeholder="New passphrase" value={newPass} onChange={(e) => setNewPass(e.target.value)} />
        <Input type="password" placeholder="Repeat new passphrase" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="outline" disabled={!oldPass || !newPass || busy}>
          {busy ? 'Re-encrypting…' : 'Change passphrase'}
        </Button>
        <FeedbackLine feedback={feedback} />
      </div>
    </form>
  );
}

function RemoveKey({ refresh }: { refresh: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <h3 className="font-medium text-base">Remove key</h3>
        <p className="text-ink-3 text-xs">Deletes the encrypted key and forgets the unlocked copy.</p>
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="destructive">Remove key</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove the API key?</DialogTitle>
            <DialogDescription>Hermod won't work until you add a key again.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button
                variant="destructive"
                onClick={async () => {
                  await rpc({ type: 'remove-key' });
                  refresh();
                }}
              >
                Remove
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ModeCard({ settings }: { settings: Settings }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Mode</CardTitle>
        <CardDescription>When Hermod asks before acting. The same choice as the mode below the prompt.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        <Field id="mode" label="Mode" hint={APPROVAL_MODE_OPTIONS.find((o) => o.value === settings.approvalMode)?.description}>
          <Select value={settings.approvalMode} onValueChange={(v) => void updateSettings({ approvalMode: v as Settings['approvalMode'] })}>
            <SelectTrigger id="mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {APPROVAL_MODE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className={o.danger ? 'text-bad-ink' : undefined}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </CardContent>
    </Card>
  );
}

function ModelCard({ settings }: { settings: Settings }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Model</CardTitle>
        <CardDescription>Haiku is fast and cheap and handles clear commands. Switch to Sonnet for fuzzier requests.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        <Field id="model" label="Model">
          <Select value={settings.model} onValueChange={(model) => void updateSettings({ model })}>
            <SelectTrigger id="model" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODELS.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="effort" label="Thinking effort" hint={EFFORT_OPTIONS.find((o) => o.value === settings.effort)?.description}>
          <Select value={settings.effort} onValueChange={(effort) => void updateSettings({ effort: effort as Effort })}>
            <SelectTrigger id="effort" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EFFORT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          id="cache"
          label="Prompt cache lifetime"
          hint={
            settings.cacheTtl === '1h'
              ? 'Cache survives an hour between commands. Writing it costs 2× instead of 1.25×.'
              : 'Cheapest when you send commands within 5 minutes of each other.'
          }
        >
          <Select value={settings.cacheTtl} onValueChange={(cacheTtl) => void updateSettings({ cacheTtl: cacheTtl as CacheTtl })}>
            <SelectTrigger id="cache" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5m">5 minutes</SelectItem>
              <SelectItem value="1h">1 hour</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </CardContent>
    </Card>
  );
}

function Key({ shortcut }: { shortcut: string | undefined }) {
  if (!shortcut) return <span className="text-ink-3">not set</span>;
  return <kbd className="rounded-[6px] border border-line bg-surface-alt px-1.5 py-0.5 font-mono text-xs">{shortcut}</kbd>;
}

function ShortcutCard() {
  const [shortcuts, setShortcuts] = useState<Record<string, string>>({});
  useEffect(() => {
    void browser.commands.getAll().then((cmds) => setShortcuts(Object.fromEntries(cmds.map((c) => [c.name ?? '', c.shortcut ?? '']))));
  }, []);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Keyboard shortcuts</CardTitle>
        <CardDescription>Two ways to open Hermod from the keyboard; keep whichever suits your browser. Change them on the extension shortcuts page.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-medium text-base">Popup</h3>
            <p className="text-ink-3 text-xs">The toolbar popup, opened by the browser. In Vivaldi it can open in another window.</p>
          </div>
          <Key shortcut={shortcuts[POPUP_COMMAND]} />
        </div>
        <Separator />
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-medium text-base">Over the window in use</h3>
            <p className="text-ink-3 text-xs">
              A Hermod window at the top right of the window you're in, closing when you click into another one, like the popup.
            </p>
          </div>
          <Key shortcut={shortcuts[OPEN_COMMAND]} />
        </div>
        <Button variant="outline" className="self-start" onClick={() => void browser.tabs.create({ url: 'chrome://extensions/shortcuts' })}>
          Open extension shortcuts
        </Button>
      </CardContent>
    </Card>
  );
}

function ClearThreads({
  which,
  count,
  onCleared,
}: {
  which: 'all' | 'stale';
  /** How many threads this would clear. */
  count: number;
  onCleared: (feedback: Feedback) => void;
}) {
  const all = which === 'all';
  const title = all ? 'Clear all threads' : 'Clear stale threads';
  const what = `${count} thread${count === 1 ? '' : 's'}`;
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <h3 className="font-medium text-base">{title}</h3>
        <p className="text-ink-3 text-xs">
          {all ? 'Deletes every saved thread.' : "Deletes every thread not started today, so only today's are kept."}
        </p>
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant={all ? 'destructive' : 'outline'} disabled={count === 0}>
            {title}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {what}?</DialogTitle>
            <DialogDescription>
              {all ? 'Every saved thread' : "Every thread from before today"} is deleted for good. A thread with a command still running is kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button
                variant="destructive"
                onClick={async () => {
                  const res = await rpc({ type: 'clear-threads', which }).catch((err: unknown) => ({ ok: false as const, error: String(err) }));
                  if (!res.ok) return onCleared({ ok: false, text: `Couldn't clear threads: ${res.error}` });
                  const cleared = res.cleared ?? 0;
                  const kept = res.keptRunning ? ` Kept ${res.keptRunning} with a command running.` : '';
                  onCleared({ ok: true, text: `Deleted ${cleared} thread${cleared === 1 ? '' : 's'}.${kept}` });
                }}
              >
                Delete
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ThreadsCard() {
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const load = useCallback(() => {
    void rpc({ type: 'list-threads' }).then((res) => setThreads(res.ok ? (res.threads ?? []) : []));
  }, []);
  useEffect(load, [load]);

  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const stale = threads?.filter((t) => t.createdAt < startOfToday).length ?? 0;
  const onCleared = (result: Feedback) => {
    setFeedback(result);
    load();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Threads</CardTitle>
        <CardDescription>
          Threads are saved in this browser.{' '}
          {threads && `You have ${threads.length} thread${threads.length === 1 ? '' : 's'}, ${stale} from before today.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ClearThreads which="stale" count={stale} onCleared={onCleared} />
        <Separator />
        <ClearThreads which="all" count={threads?.length ?? 0} onCleared={onCleared} />
        <FeedbackLine feedback={feedback} />
      </CardContent>
    </Card>
  );
}

function PageAccessCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Page access</CardTitle>
        <CardDescription>
          Hermod has access to all sites so it can read a page's text or links when you ask (for example "which of these tabs
          mentions pricing?"). It only reads a page when a command needs it, never in the background, and page content is sent
          to Claude only for that command. Browser-internal pages (chrome://, vivaldi://, edge://) and extension stores can't be read.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<KeyStatus | null>(null);

  const refresh = useCallback(() => {
    void getKeyStatus().then(setStatus);
    void getSettings().then(setSettings);
  }, []);

  useEffect(() => {
    refresh();
    const off = onSettingsChanged(setSettings);
    const onSession = (_: unknown, area: string) => area === 'session' && void getKeyStatus().then(setStatus);
    browser.storage.onChanged.addListener(onSession);
    return () => {
      off();
      browser.storage.onChanged.removeListener(onSession);
    };
  }, [refresh]);

  return (
    <div className="min-h-screen bg-ground">
      <main className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-10">
        <header className="mb-2 flex items-center gap-3">
          <img src="/icon/128.png" alt="" width={56} height={56} className="size-14 shrink-0 rounded-xl" />
          <div>
            <h1 className="font-display font-semibold text-4xl text-ink tracking-tight">Hermod Agent</h1>
            <p className="mt-1 max-w-2xl text-[12px] text-ink-3 leading-4">Settings and API keys for the Hermod browser agent.</p>
          </div>
        </header>

        {status?.hasVault && status.usesDefaultPassphrase && (
          <Alert variant="warning">
            <AlertTriangleIcon />
            <AlertTitle>You're using the default passphrase</AlertTitle>
            <AlertDescription>
              "{DEFAULT_PASSPHRASE}" is written in Hermod's source code, so while it's in use the encryption doesn't protect
              your key. Change it below.
            </AlertDescription>
          </Alert>
        )}

        {status && <KeyCard status={status} refresh={refresh} />}
        <ModeCard settings={settings} />
        <ModelCard settings={settings} />
        <ShortcutCard />
        <ThreadsCard />
        <PageAccessCard />
      </main>
    </div>
  );
}
