// Scripted stand-ins for the Claude API: each request gets the next step of
// the main agent's or the web task's script, as a streamed (SSE) response.

let toolCounter = 0;

function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function respond(model, blocks, stop) {
  const events = [
    {
      type: 'message_start',
      message: { id: `msg_${++toolCounter}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${++toolCounter}`, name: block.name, input: {} } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  events.push({ type: 'message_stop' });
  return sse(events);
}

const tool = (name, input) => ({ type: 'tool_use', name, input });
const text = (t) => ({ type: 'text', text: t });

function textOf(content) {
  if (typeof content === 'string') return content;
  return content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? textOf(b.content ?? '') : '')).join('\n');
}

/** The last tool result the request carries, as text, and any steering blocks. */
function lastResults(body) {
  const last = body.messages.at(-1);
  if (!Array.isArray(last.content)) return { result: '', steering: [] };
  const result = last.content.filter((b) => b.type === 'tool_result').map((b) => textOf(b.content ?? '')).join('\n');
  const steering = last.content.filter((b) => b.type === 'text' && b.text.startsWith('<steering>')).map((b) => b.text);
  return { result, steering };
}

export function createModel(log, base) {
  const state = { taskTab: undefined, mainWaits: 0, steeredMain: false, taskSawSteer: false, refs: {}, results: [] };

  function main(body) {
    const assistantTurns = body.messages.filter((m) => m.role === 'assistant').length;
    const { result, steering } = lastResults(body);
    if (result) state.results.push(['main', result]);
    const command = textOf(body.messages[0].content).match(/<command>\n([\s\S]*?)\n<\/command>/)?.[1] ?? '';
    if (/^(slow|quick) /.test(command)) return respond('claude-haiku-5-5', [text(`Did: ${command}`)], 'end_turn');
    if (command.startsWith('inspect ')) {
      const tabId = Number(textOf(body.messages[0].content).match(/T(\d+) #\d+ [^\n]*"Coffee shop/)?.[1]);
      const steps = [
        { tabId, text: 'Ethiopian Yirgacheffe' },
        { tabId, selector: '#cartlink', properties: ['text-decoration-line'] },
        { tabId },
        { tabId, x: 60, y: 55 },
      ];
      const name = assistantTurns === 2 ? 'screenshot' : 'inspect_element';
      if (assistantTurns < steps.length) return respond('claude-haiku-5-5', [tool(name, steps[assistantTurns])], 'tool_use');
      return respond('claude-haiku-5-5', [text('The heading is set in Inter.')], 'end_turn');
    }
    if (command.startsWith('feedback ')) {
      if (assistantTurns === 0) {
        const tab = textOf(body.messages[0].content).match(/T(\d+) #\d+ [^\n]*"Coffee shop/)?.[1];
        return respond('claude-haiku-5-5', [tool('start_web_task', { goal: 'Press Send feedback', doneWhen: 'It says sent', start: { tabId: Number(tab) } })], 'tool_use');
      }
      if (result.includes('Started web task')) return respond('claude-haiku-5-5', [tool('wait_for_web_task', { taskId: 'K1' })], 'tool_use');
      return respond('claude-haiku-5-5', [text('Sent the feedback.')], 'end_turn');
    }
    if (assistantTurns === 0) {
      const snapshot = textOf(body.messages[0].content);
      const tab = snapshot.match(/T(\d+) #\d+ [^\n]*"Coffee shop/)?.[1];
      log(`main: shop tab is T${tab}`);
      return respond('claude-haiku-5-5', [
        text('Handing this to a web task.'),
        tool('start_web_task', {
          goal: 'Add the 1 kg bag of the coffee on this page to the cart',
          context: 'The user wants the 1 kg size.',
          doneWhen: 'The cart shows it.',
          constraints: '',
          start: { tabId: Number(tab) },
        }),
      ], 'tool_use');
    }
    if (result.includes('Started web task')) return respond('claude-haiku-5-5', [tool('wait_for_web_task', { taskId: 'K1' })], 'tool_use');
    if (result.includes('still running')) {
      const words = steering.join('\n').match(/<steering>\n([\s\S]*)\n<\/steering>/)?.[1] ?? '';
      state.steeredMain = true;
      log(`main: got a steer: ${words}`);
      return respond('claude-haiku-5-5', [tool('steer_web_task', { taskId: 'K1', message: words, note: 'Use this email address.' })], 'tool_use');
    }
    if (result.includes('Passed it on')) return respond('claude-haiku-5-5', [tool('wait_for_web_task', { taskId: 'K1' })], 'tool_use');
    if (result.includes('Web task K1 ended')) {
      return respond('claude-haiku-5-5', [text('Added the 1 kg bag to your cart. The checkout is ready: enter your card details and press Place order.')], 'end_turn');
    }
    return respond('claude-haiku-5-5', [text(`Unexpected main state: ${result.slice(0, 200)}`)], 'end_turn');
  }

  function task(body) {
    const steps = body.messages.filter((m) => m.role === 'assistant').length;
    const { result, steering } = lastResults(body);
    if (result) state.results.push([`task step ${steps}`, result]);
    if (steering.length) {
      state.taskSawSteer = true;
      log(`task: read steering ${JSON.stringify(steering)}`);
    }
    if (steps === 0) state.taskTab = Number(textOf(body.messages[0].content).match(/<start>\nT(\d+)/)[1]);
    const tabId = state.taskTab;
    const ref = (pattern) => result.match(pattern)?.[1];
    if (textOf(body.messages[0].content).includes('Press Send feedback')) {
      const feedback = [
        () => tool('find', { tabId, query: 'Send feedback' }),
        () => tool('click', { tabId, ref: ref(/\[([a-z0-9]+\.\d+)\] button "Send feedback"/) }),
        () => tool('report_result', { status: 'done', summary: `Click result: ${result}`, tabIds: [tabId] }),
      ];
      if (steps < feedback.length) return respond('claude-sonnet-5-5', [feedback[steps]()], 'tool_use');
      return respond('claude-sonnet-5-5', [text('Sent.')], 'end_turn');
    }
    const script = [
      () => tool('find', { tabId, query: '1 kg' }),
      () => tool('click', { tabId, ref: ref(/\[([a-z0-9]+\.\d+)\] radio "1 kg"/) }),
      () => tool('find', { tabId, query: 'Add to cart' }),
      () => tool('click', { tabId, ref: ref(/\[([a-z0-9]+\.\d+)\] button "Add to cart"/) }),
      () => tool('read_page', { tabId }),
      () => tool('go_to', { tabId, url: `${base}/checkout` }),
      () => tool('find', { tabId, query: 'Email' }),
      () => tool('type_text', { tabId, ref: ref(/\[([a-z0-9]+\.\d+)\] textbox "Email"/), text: 'test@example.com' }),
      () => tool('find', { tabId, query: 'Card number' }),
      () => tool('type_text', { tabId, ref: ref(/\[([a-z0-9]+\.\d+)\] textbox "Card number"/), text: '4242424242424242' }),
      () => tool('find', { tabId, query: 'Place order' }),
      () => tool('click', { tabId, ref: ref(/\[([a-z0-9]+\.\d+)\] button "Place order"/) }),
      () => tool('show_page', { tabId }),
      () => tool('screenshot', { tabId }),
      () => tool('open_page', { url: `${base}/cart` }),
      () => tool('list_pages', {}),
      () =>
        tool('report_result', {
          status: 'needs_user',
          summary: 'Chose 1 kg, added it to the cart and filled in the email at checkout.',
          leftForUser: 'Enter your card details and press Place order.',
          tabIds: [tabId],
        }),
    ];
    if (steps < script.length) return respond('claude-sonnet-5-5', [script[steps]()], 'tool_use');
    return respond('claude-sonnet-5-5', [text('Ready for you to pay.')], 'end_turn');
  }

  return {
    state,
    reply(body) {
      const system = body.system.map((b) => b.text).join('\n');
      return system.includes("You are Hermod's web task agent") ? task(body) : main(body);
    },
    commandOf(body) {
      return textOf(body.messages[0].content).match(/<command>\n([\s\S]*?)\n<\/command>/)?.[1] ?? '';
    },
    isTask(body) {
      return body.system.map((b) => b.text).join('\n').includes("You are Hermod's web task agent");
    },
  };
}
