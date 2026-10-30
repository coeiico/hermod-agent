import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputController,
} from '@/components/ai-elements/prompt-input';
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion';
import { ActivityDot } from '@/components/hermod/activity-dot';
import { OptionMenu } from '@/components/hermod/option-menu';
import { QueuedMessages } from '@/components/hermod/queued-messages';
import { RunView } from '@/components/hermod/run-view';
import { SlashMenu } from '@/components/hermod/slash-menu';
import { ThreadList } from '@/components/hermod/thread-list';
import { UnlockDialog } from '@/components/hermod/unlock-dialog';
import { UsageMeter } from '@/components/hermod/usage-meter';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EFFORT_OPTIONS, MODELS } from '@/ai/models';
import { isDetachedPage, isQuickPage } from '@/lib/detached-window';
import { canResume, type RunUsage, type ThreadActivity } from '@/lib/run';
import { getKeyStatus, rpc, type KeyStatus } from '@/lib/rpc';
import { APPROVAL_MODE_OPTIONS, DEFAULT_SETTINGS, getSettings, onSettingsChanged, updateSettings, type Settings } from '@/lib/settings';
import { matchSlashCommands, resolveSlashCommand } from '@/lib/slash-commands';
import { useRun } from '@/lib/use-run';
import {
  KeyRoundIcon,
  LockIcon,
  LockOpenIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  SettingsIcon,
  SparklesIcon,
  SquareArrowDownLeftIcon,
  SquareArrowOutUpRightIcon,
  SquarePenIcon,
  XIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

// The popped-out window fills itself; the toolbar popup has a fixed size.
const DETACHED = isDetachedPage();
// The shortcut's window, which closes when it loses focus: it offers Pop out, like the toolbar popup.
const QUICK = isQuickPage();

const MODEL_OPTIONS = MODELS.map((m) => ({ value: m.id, label: m.name.replace('Claude ', ''), description: m.description }));
const EFFORT_MENU_OPTIONS = EFFORT_OPTIONS.map((o) => ({ ...o, label: `${o.label} effort` }));

const SUGGESTIONS = [
  'Move this tab to a new window',
  'Add this to my cart',
  'Put all my YouTube tabs in a new window',
  'Sort this window by site',
  'Close duplicate tabs',
  'Merge all windows into this one',
  'Mute every tab playing audio',
  'Reopen the tab I just closed',
];

/** Baritone's toolbar chip: a quiet surface pill that lifts to `ink` on hover. */
const SUGGESTION_CHIP =
  'h-[var(--control-h)] rounded-[10px] border-line-strong/80 bg-surface px-2.5 text-ink-2 hover:border-ink-3/60 hover:bg-surface-alt hover:text-ink dark:border-line-strong/80 dark:bg-surface dark:hover:bg-surface-alt';

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" variant="ghost" className="text-ink-2 hover:text-ink" onClick={onClick} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The prompt. While a command runs, sending queues the message (or steers it,
 * from the queue) and an empty prompt's button stops the command. Typing a
 * slash offers the slash commands; Tab completes the first.
 */
function Composer({
  running,
  disabled,
  placeholder,
  onSubmit,
  onStop,
}: {
  running: boolean;
  disabled: boolean;
  placeholder: string;
  onSubmit: (text: string) => void;
  onStop: () => void;
}) {
  const { textInput } = usePromptInputController();
  const hasText = !!textInput.value.trim();
  const slashMatches = matchSlashCommands(textInput.value);
  return (
    <>
      {slashMatches.length > 0 && (
        <SlashMenu
          commands={slashMatches}
          onPick={(name) => {
            textInput.clear();
            onSubmit(`/${name}`);
          }}
        />
      )}
      <PromptInput
        onSubmit={({ text }) => {
          if (text.trim()) onSubmit(text.trim());
        }}
      >
        <PromptInputBody>
          <PromptInputTextarea
            autoFocus
            disabled={disabled}
            className="min-h-12"
            placeholder={placeholder}
            onKeyDown={(e) => {
              if (e.key !== 'Tab' || e.shiftKey || !slashMatches.length) return;
              e.preventDefault();
              textInput.setInput(`/${slashMatches[0]!.name}`);
            }}
          />
        </PromptInputBody>
        <PromptInputFooter className="justify-end">
          <PromptInputSubmit
            variant="ghost"
            className="text-ink hover:text-ink disabled:text-ink-3"
            status={running && !hasText ? 'streaming' : 'ready'}
            onStop={onStop}
            disabled={disabled || (!running && !hasText)}
          />
        </PromptInputFooter>
      </PromptInput>
    </>
  );
}

/** Below the prompt, as in Claude Code: the mode on the left; context, effort and model on the right. */
function ComposerBar({ settings, usage }: { settings: Settings; usage: { usage: RunUsage; modelId: string } | null }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <OptionMenu
        name="Mode"
        align="start"
        value={settings.approvalMode}
        options={APPROVAL_MODE_OPTIONS}
        onChange={(approvalMode) => void updateSettings({ approvalMode })}
      />
      <div className="flex items-center gap-0.5">
        {usage && <UsageMeter usage={usage.usage} modelId={usage.modelId} />}
        <OptionMenu
          name="Thinking effort"
          value={settings.effort}
          options={EFFORT_MENU_OPTIONS}
          onChange={(effort) => void updateSettings({ effort })}
        />
        <OptionMenu name="Model" value={settings.model} options={MODEL_OPTIONS} onChange={(model) => void updateSettings({ model })} />
      </div>
    </div>
  );
}

function SuggestionRow({ onPick }: { onPick: (s: string) => void }) {
  return (
    <Suggestions>
      {SUGGESTIONS.map((s) => (
        <Suggestion key={s} suggestion={s} onClick={onPick} className={SUGGESTION_CHIP} />
      ))}
    </Suggestions>
  );
}

export default function App() {
  const {
    thread,
    run,
    error,
    clearError,
    needsUnlock,
    start,
    resume,
    resumeAfterUnlock,
    cancelUnlock,
    approve,
    stop,
    steer,
    unqueue,
    runQueued,
    openThread,
    newThread,
    deleteThread,
    running,
    queue,
    activity,
  } = useRun();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [view, setView] = useState<'run' | 'threads'>('run');
  // Unlocking from the lock button, before any command needs the key.
  const [unlocking, setUnlocking] = useState(false);
  // What the last slash command did. They run in the worker without the model, so they leave nothing in the thread.
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null);

  const refreshKeyStatus = useCallback(() => void getKeyStatus().then(setKeyStatus), []);

  // Escape closes the quick window, as it does the toolbar popup (unless a dialog has it).
  useEffect(() => {
    if (!QUICK) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"]')) window.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    void getSettings().then(setSettings);
    refreshKeyStatus();
    const off = onSettingsChanged(setSettings);
    // The unlocked key lives in storage.session: follow locking and unlocking done elsewhere, like Settings.
    const onSession = (_: unknown, area: string) => area === 'session' && refreshKeyStatus();
    browser.storage.onChanged.addListener(onSession);
    return () => {
      off();
      browser.storage.onChanged.removeListener(onSession);
    };
  }, [refreshKeyStatus]);

  const runSlashCommand = async (text: string) => {
    setNotice(null);
    try {
      const res = await rpc({ type: 'slash-command', name: resolveSlashCommand(text) });
      setNotice(res.ok ? { text: res.message ?? 'Done.', failed: false } : { text: res.error, failed: true });
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : String(err), failed: true });
    }
  };

  const submit = (text: string) => {
    setView('run');
    if (text.startsWith('/')) void runSlashCommand(text);
    else start(text);
  };

  const noKey = keyStatus !== null && !keyStatus.hasVault;
  const turns = thread?.turns ?? [];
  const lastTurn = turns.at(-1);
  const resumable = !running && !queue.length && lastTurn && canResume(lastTurn) ? lastTurn.id : null;
  // The most urgent news from threads other than the open one, for the threads button.
  const elsewhere = (['waiting', 'running', 'failed', 'done'] as ThreadActivity[]).find((a) =>
    Object.entries(activity).some(([id, value]) => id !== thread?.id && value === a),
  );
  // The usage meter follows the command in progress, else the thread's last one.
  const latest = run ?? turns.at(-1) ?? null;

  return (
    <PromptInputProvider>
      <div className={`flex flex-col gap-2 bg-ground p-2 ${DETACHED ? 'h-screen w-screen' : 'h-[600px] w-[420px]'}`}>
        <header className="flex items-center gap-1 pl-1.5">
          <span className="font-display font-semibold text-[17px] text-ink leading-[22px] tracking-tight">Hermod</span>
          {thread && view === 'run' && <span className="min-w-0 truncate pl-1 text-ink-3 text-sm">{thread.title}</span>}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {(thread || view === 'threads') && (
              <HeaderButton
                label="New thread"
                onClick={() => {
                  newThread();
                  setView('run');
                }}
              >
                <SquarePenIcon />
              </HeaderButton>
            )}
            <HeaderButton label={view === 'threads' ? 'Back to the open thread' : 'Threads'} onClick={() => setView(view === 'threads' ? 'run' : 'threads')}>
              <span className="relative">
                {view === 'threads' ? <MessageSquareIcon /> : <MessagesSquareIcon />}
                {view === 'run' && <ActivityDot activity={elsewhere} className="-top-0.5 -right-0.5 absolute ring-2 ring-ground" />}
              </span>
            </HeaderButton>
            {keyStatus?.hasVault && (
              <HeaderButton
                label={keyStatus.unlocked ? 'Lock (forget the unlocked key)' : 'Unlock your API key'}
                onClick={async () => {
                  if (!keyStatus.unlocked) return setUnlocking(true);
                  await rpc({ type: 'lock' });
                  refreshKeyStatus();
                }}
              >
                {keyStatus.unlocked ? <LockOpenIcon /> : <LockIcon />}
              </HeaderButton>
            )}
            {DETACHED && !QUICK ? (
              <HeaderButton label="Reattach to the toolbar" onClick={() => void rpc({ type: 'reattach' })}>
                <SquareArrowDownLeftIcon />
              </HeaderButton>
            ) : (
              <HeaderButton
                label="Pop out into a window"
                onClick={async () => {
                  const res = await rpc({ type: 'pop-out' });
                  // The quick window becomes the popped-out one in place; the toolbar popup closes.
                  if (res.ok && !QUICK) window.close();
                }}
              >
                <SquareArrowOutUpRightIcon />
              </HeaderButton>
            )}
            <HeaderButton label="Settings" onClick={() => void browser.runtime.openOptionsPage()}>
              <SettingsIcon />
            </HeaderButton>
          </div>
        </header>

        {view === 'threads' ? (
          // The same shadcn scroll area as the chat. Radix wraps its content in a `display: table`
          // div, which would let long titles widen the pane instead of truncating; `block` stops it.
          <ScrollArea className="min-h-0 flex-1 rounded-[12px] border border-line bg-surface [&_[data-slot=scroll-area-viewport]>div]:block!">
            <ThreadList
              activeId={thread?.id ?? null}
              activity={activity}
              onOpen={(id) => {
                openThread(id);
                setView('run');
              }}
              onNew={() => {
                newThread();
                setView('run');
              }}
              onDelete={deleteThread}
            />
          </ScrollArea>
        ) : (
          <Conversation className="min-h-0 flex-1 rounded-[12px] border border-line bg-surface">
            <ConversationContent className="gap-4 p-3">
              {turns.length || run || queue.length ? (
                <>
                  {turns.map((turn) => (
                    <RunView key={turn.id} run={turn} onApprove={approve} onResume={turn.id === resumable ? resume : undefined} />
                  ))}
                  {run && <RunView run={run} onApprove={approve} />}
                  <QueuedMessages queue={queue} running={running} onSteer={steer} onRun={runQueued} onRemove={unqueue} />
                </>
              ) : noKey ? (
                <ConversationEmptyState className="pt-16">
                  <KeyRoundIcon className="size-6 text-ink-3" />
                  <div className="space-y-1">
                    <h3 className="font-medium text-base text-ink">Add your Claude API key</h3>
                    <p className="text-ink-3 text-sm">
                      Hermod uses a Claude Console API key (pay-as-you-go). It's encrypted with a passphrase and stays in this browser.
                    </p>
                  </div>
                  <Button onClick={() => void browser.runtime.openOptionsPage()}>
                    Open Manage keys
                  </Button>
                </ConversationEmptyState>
              ) : (
                <ConversationEmptyState
                  className="pt-16"
                  icon={<SparklesIcon className="size-6 text-ink-3" />}
                  title="What shall I do next?"
                  description="Move, close, sort, find or reopen tabs and windows in plain words, or hand Hermod a job on a website. Try a suggestion below."
                />
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        )}

        <div className="flex flex-col gap-2">
          {error && (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="flex items-center justify-between gap-2">
                <span>{error}</span>
                <Button size="icon-sm" variant="ghost" onClick={clearError} aria-label="Dismiss">
                  <XIcon />
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {notice && (
            <Alert variant={notice.failed ? 'destructive' : 'default'} className="py-2">
              <AlertDescription className="flex items-center justify-between gap-2">
                <span>{notice.text}</span>
                <Button size="icon-sm" variant="ghost" onClick={() => setNotice(null)} aria-label="Dismiss">
                  <XIcon />
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {!running && !queue.length && !noKey && view === 'run' && <SuggestionRow onPick={submit} />}
          <Composer
            running={running}
            disabled={noKey}
            placeholder={
              noKey
                ? 'Add an API key in Settings to start'
                : running
                  ? 'Send a follow-up: it waits its turn, or steer it in'
                  : 'Tell Hermod what’s next…'
            }
            onSubmit={submit}
            onStop={stop}
          />
          <ComposerBar
            settings={settings}
            usage={latest && latest.usage.rounds > 0 && view === 'run' ? { usage: latest.usage, modelId: latest.model } : null}
          />
        </div>

        <UnlockDialog
          open={needsUnlock || unlocking}
          onCancel={() => {
            setUnlocking(false);
            cancelUnlock();
          }}
          onUnlocked={() => {
            setUnlocking(false);
            refreshKeyStatus();
            resumeAfterUnlock();
          }}
        />
      </div>
    </PromptInputProvider>
  );
}
