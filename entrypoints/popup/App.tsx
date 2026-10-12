import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
} from '@/components/ai-elements/prompt-input';
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion';
import { HistoryList } from '@/components/hermod/history-list';
import { ModelPicker } from '@/components/hermod/model-picker';
import { RunView } from '@/components/hermod/run-view';
import { UnlockDialog } from '@/components/hermod/unlock-dialog';
import { UsageMeter } from '@/components/hermod/usage-meter';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EFFORT_OPTIONS, type Effort } from '@/lib/models';
import { getKeyStatus, rpc, type KeyStatus } from '@/lib/rpc';
import { DEFAULT_SETTINGS, getSettings, onSettingsChanged, updateSettings, type Settings } from '@/lib/settings';
import { useRun } from '@/lib/use-run';
import { HistoryIcon, KeyRoundIcon, LockIcon, LockOpenIcon, MessageSquareIcon, SettingsIcon, SparklesIcon, XIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

const SUGGESTIONS = [
  'Move this tab to a new window',
  'Put all my YouTube tabs in a new window',
  'Sort this window by site',
  'Close duplicate tabs',
  'Merge all windows into this one',
  'Mute every tab playing audio',
  'Reopen the tab I just closed',
];

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" variant="ghost" className="size-8" onClick={onClick} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Composer({
  settings,
  running,
  disabled,
  onSubmit,
  onStop,
}: {
  settings: Settings;
  running: boolean;
  disabled: boolean;
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
          className="min-h-12 text-sm"
          placeholder={disabled ? 'Add an API key in Settings to start' : 'Tell Hermod what to do with your tabs…'}
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <ModelPicker value={settings.model} onChange={(model) => void updateSettings({ model })} />
          <PromptInputSelect value={settings.effort} onValueChange={(effort) => void updateSettings({ effort: effort as Effort })}>
            <PromptInputSelectTrigger className="h-8 text-xs" aria-label="Thinking effort">
              <PromptInputSelectValue />
            </PromptInputSelectTrigger>
            <PromptInputSelectContent>
              {EFFORT_OPTIONS.map((o) => (
                <PromptInputSelectItem key={o.value} value={o.value}>
                  {o.label} effort
                </PromptInputSelectItem>
              ))}
            </PromptInputSelectContent>
          </PromptInputSelect>
        </PromptInputTools>
        <PromptInputSubmit
          status={running ? 'streaming' : 'ready'}
          onStop={onStop}
          disabled={disabled || (!running && !textInput.value.trim())}
        />
      </PromptInputFooter>
    </PromptInput>
  );
}

function SuggestionRow({ onPick }: { onPick: (s: string) => void }) {
  return (
    <Suggestions className="px-3">
      {SUGGESTIONS.map((s) => (
        <Suggestion key={s} suggestion={s} onClick={onPick} className="h-7 text-xs" />
      ))}
    </Suggestions>
  );
}

export default function App() {
  const { run, error, clearError, needsUnlock, start, resumeAfterUnlock, cancelUnlock, approve, stop, running } = useRun();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [view, setView] = useState<'run' | 'history'>('run');

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

  return (
    <PromptInputProvider>
      <div className="flex h-[600px] w-[420px] flex-col bg-background">
        <header className="flex items-center gap-1 border-b px-3 py-1.5">
          <SparklesIcon className="size-4" />
          <span className="font-semibold text-sm">Hermod</span>
          <div className="ml-auto flex items-center gap-0.5">
            {run && run.usage.rounds > 0 && view === 'run' && <UsageMeter usage={run.usage} modelId={run.model} />}
            <HeaderButton label={view === 'history' ? 'Back to current command' : 'Earlier commands'} onClick={() => setView(view === 'history' ? 'run' : 'history')}>
              {view === 'history' ? <MessageSquareIcon /> : <HistoryIcon />}
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
            <HeaderButton label="Settings" onClick={() => void browser.runtime.openOptionsPage()}>
              <SettingsIcon />
            </HeaderButton>
          </div>
        </header>

        {view === 'history' ? (
          <div className="flex-1 overflow-y-auto">
            <HistoryList />
          </div>
        ) : (
          <Conversation className="flex-1">
            <ConversationContent className="gap-4 p-3">
              {run ? (
                <RunView run={run} onApprove={approve} />
              ) : noKey ? (
                <ConversationEmptyState className="pt-16">
                  <KeyRoundIcon className="size-8 text-muted-foreground" />
                  <div className="space-y-1">
                    <h3 className="font-medium text-sm">Add your Claude API key</h3>
                    <p className="text-muted-foreground text-sm">
                      Hermod uses a Claude Console API key (pay-as-you-go). It's encrypted with a passphrase and stays in this browser.
                    </p>
                  </div>
                  <Button size="sm" onClick={() => void browser.runtime.openOptionsPage()}>
                    Open Manage keys
                  </Button>
                </ConversationEmptyState>
              ) : (
                <ConversationEmptyState
                  className="pt-16"
                  icon={<SparklesIcon className="size-8" />}
                  title="What should I do with your tabs?"
                  description="Move, close, sort, find or reopen tabs and windows in plain words. Try a suggestion below."
                />
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        )}

        <div className="flex flex-col gap-2 border-t pt-2 pb-3">
          {error && (
            <Alert variant="destructive" className="mx-3 w-auto py-2">
              <AlertDescription className="flex items-center justify-between gap-2">
                <span>{error}</span>
                <Button size="icon" variant="ghost" className="size-6" onClick={clearError} aria-label="Dismiss">
                  <XIcon />
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {!running && !noKey && view === 'run' && <SuggestionRow onPick={submit} />}
          <div className="px-3">
            <Composer settings={settings} running={running} disabled={noKey} onSubmit={submit} onStop={stop} />
          </div>
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
