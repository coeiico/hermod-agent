import { describe, expect, it } from 'vitest';
import { RunController } from './run-controller';

describe('RunController.failDanglingTools', () => {
  it('says whether each unfinished tool call had started', () => {
    const ctrl = new RunController('tidy up', 'claude-haiku-5-5', false, () => {});
    ctrl.handle({ type: 'tool-input-started', block: 0, callId: 't1', name: 'move_tabs' });
    ctrl.handle({ type: 'tool-input-started', block: 1, callId: 't2', name: 'close_tabs' });
    ctrl.handle({ type: 'tool-call-started', callId: 't1', name: 'move_tabs', input: { tabIds: [1] } });
    ctrl.failDanglingTools('stopped by the user');

    const errors = ctrl.state.messages[1]?.parts.map((p) => (p.type === 'dynamic-tool' ? p.errorText : undefined));
    expect(errors).toEqual([
      'Interrupted: stopped by the user. It may already have taken effect.',
      'Not run: stopped by the user.',
    ]);
  });
});
