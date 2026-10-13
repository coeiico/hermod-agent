import { describe, expect, it } from 'vitest';
import { refusal, risk, type ElementDescriptor } from './page-guardrails';

const input = (extra: Partial<ElementDescriptor>): ElementDescriptor => ({ tag: 'input', type: 'text', ...extra });
const button = (text: string, extra: Partial<ElementDescriptor> = {}): ElementDescriptor => ({ tag: 'button', type: 'button', text, ...extra });
const form = (fields: ElementDescriptor[], submitter?: ElementDescriptor) => ({ fields, submitter });

describe('refusal', () => {
  it('refuses typing into password, one-time-code and PIN fields', () => {
    expect(refusal(input({ type: 'password' }), 'type')).toMatch(/passwords/);
    expect(refusal(input({ autocomplete: 'one-time-code' }), 'type')).toMatch(/passwords/);
    expect(refusal(input({ name: 'pin' }), 'type')).toMatch(/passwords/);
    expect(refusal(input({ label: 'Verification code' }), 'type')).toMatch(/passwords/);
  });

  it('refuses card and bank fields, by autocomplete or by name', () => {
    expect(refusal(input({ autocomplete: 'cc-number' }), 'type')).toMatch(/card/);
    expect(refusal(input({ name: 'cardNumber' }), 'type')).toMatch(/card/);
    expect(refusal(input({ label: 'CVV' }), 'type')).toMatch(/card/);
    expect(refusal({ tag: 'select', autocomplete: 'cc-exp-month' }, 'select')).toMatch(/card/);
    expect(refusal(input({ label: 'IBAN' }), 'type')).toMatch(/bank/);
  });

  it('lets ordinary fields through, including a postal PIN code', () => {
    expect(refusal(input({ name: 'email', autocomplete: 'email' }), 'type')).toBeNull();
    expect(refusal(input({ label: 'Search products' }), 'type')).toBeNull();
    expect(refusal(input({ label: 'PIN code' }), 'type')).toBeNull();
  });

  it('refuses pressing the final order or payment button', () => {
    expect(refusal(button('Place order'), 'click')).toMatch(/final order or payment/);
    expect(refusal(button('Pay £42.10'), 'click')).toMatch(/final/);
    expect(refusal(button('Buy now'), 'click')).toMatch(/final/);
    expect(refusal(button('Confirm payment'), 'click')).toMatch(/final/);
    expect(refusal({ tag: 'a', text: 'Send money' }, 'click')).toMatch(/final/);
  });

  it('refuses Enter in a field whose form submits with a final-step button', () => {
    const el = input({ name: 'note', form: form([input({ name: 'note' })], button('Complete purchase', { type: 'submit' })) });
    expect(refusal(el, 'enter')).toMatch(/final/);
  });

  it('refuses submitting a form that holds card fields, whatever the button says', () => {
    const submit = button('Continue', { type: 'submit', form: form([input({ autocomplete: 'cc-number' })]) });
    expect(refusal(submit, 'click')).toMatch(/payment card fields/);
  });

  it('lets ordinary buttons and links through', () => {
    expect(refusal(button('Add to cart'), 'click')).toBeNull();
    expect(refusal({ tag: 'a', text: 'Payment options' }, 'click')).toBeNull();
    expect(refusal(button('Proceed to checkout'), 'click')).toBeNull();
  });
});

describe('risk', () => {
  it('always asks before sending, posting, deleting or unsubscribing, and before file inputs', () => {
    expect(risk(button('Send'), 'click')).toBe('always');
    expect(risk({ tag: 'a', text: 'Delete repository' }, 'click')).toBe('always');
    expect(risk(button('Unsubscribe'), 'click')).toBe('always');
    expect(risk(button('Cancel subscription'), 'click')).toBe('always');
    expect(risk(input({ type: 'file' }), 'click')).toBe('always');
    const reply = input({ name: 'q', form: form([], button('Post reply', { type: 'submit' })) });
    expect(risk(reply, 'enter')).toBe('always');
  });

  it('marks form submits', () => {
    const f = form([input({ name: 'q' })]);
    expect(risk(button('Search', { type: 'submit', form: f }), 'click')).toBe('submit');
    expect(risk(input({ name: 'q', form: f }), 'enter')).toBe('submit');
    expect(risk({ tag: 'input', type: 'submit', text: 'Go', form: f }, 'click')).toBe('submit');
  });

  it('leaves ordinary actions alone', () => {
    expect(risk(button('Next page'), 'click')).toBeNull();
    expect(risk(input({ name: 'comment', label: 'Comment' }), 'click')).toBeNull();
    expect(risk(input({ name: 'q' }), 'type')).toBeNull();
    expect(risk({ tag: 'textarea', form: form([]) }, 'enter')).toBeNull();
  });
});
