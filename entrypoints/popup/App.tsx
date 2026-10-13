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
import { OptionMenu } from '@/components/hermod/option-menu';
import { RunView } from '@/components/hermod/run-view';
import { ThreadList } from '@/components/hermod/thread-list';
import { UnlockDialog } from '@/components/hermod/unlock-dialog';
import { UsageMeter } from '@/components/hermod/usage-meter';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EFFORT_OPTIONS, MODELS } from '@/ai/models';
import { isDetachedPage } from '@/lib/detached-window';
import { canResume, type RunUsage } from '@/lib/run';
import { getKeyStatus, rpc, type KeyStatus } from '@/lib/rpc';
import { APPROVAL_MODE_OPTIONS, DEFAULT_SETTINGS, getSettings, onSettingsChanged, updateSettings, type Settings } from '@/lib/settings';
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

const MODEL_OPTIONS = MODELS.map((m) => ({ value: m.id, label: m.name.replace('Claude ', ''), description: m.description }));
const EFFORT_MENU_OPTIONS = EFFORT_OPTIONS.map((o) => ({ ...o, label: `${o.label} effort` }));

const SUGGESTIONS = [
  'Move this tab to a new window',
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
  return (
    <PromptInput
      onSubmit={({ text }) => {
        if (text.trim() && !running) onSubmit(text.trim());
      }}
    >
      <PromptInputBody>
        <PromptInputTextarea
          autoFocus
          disabled={disabled}
          className="min-h-12"
          placeholder={placeholder}
        />
      </PromptInputBody>
      <PromptInputFooter className="justify-end">
        <PromptInputSubmit
          variant="ghost"
          className="text-ink hover:text-ink disabled:text-ink-3"
          status={running ? 'streaming' : 'ready'}
          onStop={onStop}
          disabled={disabled || (!running && !textInput.value.trim())}
        />
      </PromptInputFooter>
    </PromptInput>
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
    openThread,
    newThread,
    deleteThread,
    running,
    runningThreadId,
  } = useRun();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [view, setView] = useState<'run' | 'threads'>('run');

  const refreshKeyStatus = useCallback(() => void getKeyStatus().then(setKeyStatus), []);

  useEffect(() => {
    void getSettings().then(setSettings);
    refreshKeyStatus();
    return onSettingsChanged(setSettings);
  }, [refreshKeyStatus]);

  const submit = (text: string) => {
    setView('run');
    start(text);
  };

  const noKey = keyStatus !== null && !keyStatus.hasVault;
  // A command is running in a thread other than the one shown; only one runs at a time.
  const busyElsewhere = runningThreadId !== null && runningThreadId !== thread?.id;
  const turns = thread?.turns ?? [];
  const lastTurn = turns.at(-1);
  const resumable = !runningThreadId && lastTurn && canResume(lastTurn) ? lastTurn.id : null;
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
              {view === 'threads' ? <MessageSquareIcon /> : <MessagesSquareIcon />}
            </HeaderButton>
            {keyStatus?.hasVault && (
              <HeaderButton
                label={keyStatus.unlocked ? 'Lock (forget the unlocked key)' : 'Locked'}
                onClick={async () => {
                  if (keyStatus.unlocked) {
                    await rpc({ type: 'lock' });
                    refreshKeyStatus();
                  }
                }}
              >
                {keyStatus.unlocked ? <LockOpenIcon /> : <LockIcon />}
              </HeaderButton>
            )}
            {DETACHED ? (
              <HeaderButton label="Reattach to the toolbar" onClick={() => void rpc({ type: 'reattach' })}>
                <SquareArrowDownLeftIcon />
              </HeaderButton>
            ) : (
              <HeaderButton
                label="Pop out into a window"
                onClick={async () => {
                  const res = await rpc({ type: 'pop-out' });
                  if (res.ok) window.close();
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
          <div className="min-h-0 flex-1 overflow-y-auto rounded-[12px] border border-line bg-surface">
            <ThreadList
              activeId={thread?.id ?? null}
              runningId={runningThreadId}
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
          </div>
        ) : (
          <Conversation className="min-h-0 flex-1 rounded-[12px] border border-line bg-surface">
            <ConversationContent className="gap-4 p-3">
              {turns.length || run ? (
                <>
                  {turns.map((turn) => (
                    <RunView key={turn.id} run={turn} onApprove={approve} onResume={turn.id === resumable ? resume : undefined} />
                  ))}
                  {run && <RunView run={run} onApprove={approve} />}
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
                  description="Move, close, sort, find or reopen tabs and windows in plain words. Try a suggestion below."
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
          {busyElsewhere && (
            <div className="flex items-center justify-between gap-2 rounded-[10px] border border-line bg-surface px-3 py-1.5 text-ink-2 text-sm">
              <span>A command is running in another thread.</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  openThread(runningThreadId);
                  setView('run');
                }}
              >
                Go to it
              </Button>
            </div>
          )}
          {!running && !busyElsewhere && !noKey && view === 'run' && <SuggestionRow onPick={submit} />}
          <Composer
            running={running}
            disabled={noKey || busyElsewhere}
            placeholder={
              noKey
                ? 'Add an API key in Settings to start'
                : busyElsewhere
                  ? 'Wait for the other command to finish, or stop it there'
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
          open={needsUnlock}
          onCancel={cancelUnlock}
          onUnlocked={() => {
            refreshKeyStatus();
            resumeAfterUnlock();
          }}
        />
      </div>
    </PromptInputProvider>
  );
}
