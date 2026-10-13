// The hard-coded rules for acting in a page, decided on a plain description of
// the element (built in the page by page-script.ts). They sit under every
// approval mode: a refusal is never done, and an `always` action is always
// asked about, even in "Don't ask".
//
// The rules match markup and English wording, so they are a backstop, not a
// guarantee: a site can label its payment button "Continue". The web task's
// prompt carries the same rules.

/** What the guardrails know about an element. */
export interface ElementDescriptor {
  tag: string;
  /** The `type` property: `submit` for a button with no type, `password`, `checkbox`… */
  type?: string;
  role?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
  inputmode?: string;
  /** Its label, aria-label or placeholder. */
  label?: string;
  /** Its visible text, or a button input's value. */
  text?: string;
  /** The form it belongs to, if any. */
  form?: {
    fields: ElementDescriptor[];
    /** The button that submits the form when Enter is pressed in a field. */
    submitter?: ElementDescriptor;
  };
}

/** `enter` is pressing Enter in a field, which submits its form. */
export type PageAction = 'click' | 'type' | 'select' | 'enter';

const PASSWORD_AUTOCOMPLETE = /\b(current-password|new-password|one-time-code)\b/;
const PASSWORD_WORDS = /passw|passcode|\bpin\b(?!\s*-?code)|one.?time|\botp\b|\b2fa\b|verification.?code|security.?answer/i;
const CARD_WORDS = /card.?(num|no\b|code|holder|verif)|\bcc.?(num|csc|cvv|exp)|credit.?card|debit.?card|\bcvv|\bcvc|\bcsc\b|security.?code|expir|\bexp.?(date|month|year|mm|yy)|\bmm\s*\/\s*yy/i;
const BANK_WORDS = /\biban\b|routing.?(number|no\b)|account.?(number|no\b)|sort.?code|\bbsb\b|\bswift\b|\bssn\b|social.?security|tax.?id/i;

const FINAL_STEP =
  /\b(place|complete|submit|confirm|finish)\s+(my\s+|your\s+|the\s+)?(order|purchase|payment|booking|reservation|checkout)\b|\bbuy\s+(it\s+)?now\b|\bpay\b|\bcomplete\s+(purchase|checkout)\b|\bsend\s+(money|payment|funds)\b|\btransfer\s+(money|funds|now)\b|^\s*transfer\s*$|\bdonate\b|\bsubscribe\s+(and|&)\s+pay\b|\bstart\s+(my\s+)?(paid\s+)?subscription\b/i;
const ALWAYS_ASK =
  /\b(send|post|publish|reply|comment|delete|remove|unsubscribe)\b|\bcancel\s+(my\s+|the\s+)?(subscription|membership|order|account|plan)\b|\b(close|deactivate|delete)\s+(my\s+)?account\b/i;

function fieldText(el: ElementDescriptor): string {
  return [el.name, el.id, el.label].filter(Boolean).join(' ');
}

function buttonText(el: ElementDescriptor): string {
  return [el.text, el.label].filter(Boolean).join(' ');
}

function isPasswordField(el: ElementDescriptor): boolean {
  return el.type === 'password' || PASSWORD_AUTOCOMPLETE.test(el.autocomplete ?? '') || PASSWORD_WORDS.test(fieldText(el));
}

function isCardField(el: ElementDescriptor): boolean {
  return (el.autocomplete ?? '').split(/\s+/).some((t) => t.startsWith('cc-')) || CARD_WORDS.test(fieldText(el));
}

function isBankField(el: ElementDescriptor): boolean {
  return BANK_WORDS.test(fieldText(el));
}

/** A field that only takes text: what typing and selecting act on. */
function isField(el: ElementDescriptor): boolean {
  return el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select' || el.role === 'textbox' || el.role === 'combobox';
}

function isSubmitButton(el: ElementDescriptor): boolean {
  if (!el.form) return false;
  if (el.tag === 'button') return el.type === 'submit';
  return el.tag === 'input' && (el.type === 'submit' || el.type === 'image');
}

/** The button this action effectively presses, if it presses one. */
function pressed(el: ElementDescriptor, action: PageAction): ElementDescriptor | undefined {
  if (action === 'click') return el;
  if (action === 'enter') return el.form?.submitter;
  return undefined;
}

/** Whether this action submits a form. */
function submits(el: ElementDescriptor, action: PageAction): boolean {
  if (action === 'click') return isSubmitButton(el);
  return action === 'enter' && !!el.form && el.tag !== 'textarea';
}

/** Why Hermod will not do this, in any mode, or null when it may. The message is written for the model. */
export function refusal(el: ElementDescriptor, action: PageAction): string | null {
  if (action === 'type' || action === 'select') {
    if (isPasswordField(el)) return 'Hermod never enters passwords, PINs or one-time codes. Stop here and ask the user to enter it themselves.';
    if (isCardField(el)) return 'Hermod never enters payment card details. Stop here and ask the user to enter them themselves.';
    if (isBankField(el)) return 'Hermod never enters bank account or identity numbers. Stop here and ask the user to enter it themselves.';
    return null;
  }
  const button = pressed(el, action);
  if (button && FINAL_STEP.test(buttonText(button))) {
    return `"${buttonText(button).trim().slice(0, 60)}" looks like the final order or payment step. Hermod never presses it: stop here and tell the user what is left for them to do.`;
  }
  if (submits(el, action) && el.form?.fields.some(isCardField)) {
    return 'This submits a form with payment card fields. Hermod never does that: stop here and tell the user what is left for them to do.';
  }
  return null;
}

/**
 * How much this action matters when Hermod may do it: `always` (asked in every
 * mode), `submit` (asked in ask and auto mode), or null (an ordinary action).
 */
export function risk(el: ElementDescriptor, action: PageAction): 'always' | 'submit' | null {
  if (action === 'click' && el.tag === 'input' && el.type === 'file') return 'always';
  const button = pressed(el, action);
  if (button && !isField(button) && ALWAYS_ASK.test(buttonText(button))) return 'always';
  if (submits(el, action)) return 'submit';
  return null;
}
