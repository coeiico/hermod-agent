// The code a web task runs inside a page, injected with scripting.executeScript.
// executeScript sends the function's source, not its closure: everything it
// uses must be defined inside it. Only types may come from outside.
//
// It runs in the extension's isolated world, which persists for the life of
// the document, so the refs it hands out survive between calls until the page
// changes. Each document tags its refs, so a ref from an earlier page fails
// instead of pointing at an unrelated element.
import type { ElementDescriptor } from './page-guardrails';

export type PageKey =
  | 'Enter'
  | 'Escape'
  | 'Tab'
  | 'Shift+Tab'
  | 'Space'
  | 'Backspace'
  | 'Delete'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'PageUp'
  | 'PageDown'
  | 'Home'
  | 'End';

export type PageRequest =
  | { op: 'outline'; filter: 'interactive' | 'all'; maxChars: number }
  | { op: 'text'; maxChars: number }
  | { op: 'find'; query: string; limit: number }
  | { op: 'describe'; ref: string }
  /** The element at a point in CSS pixels, given a ref. */
  | { op: 'at-point'; x: number; y: number }
  | { op: 'click'; ref: string }
  | { op: 'type'; ref: string; text: string; clear: boolean }
  | { op: 'select'; ref: string; option: string }
  | { op: 'key'; key: PageKey; ref?: string }
  | { op: 'scroll'; direction?: 'up' | 'down' | 'top' | 'bottom'; ref?: string }
  | { op: 'has'; text?: string; ref?: string }
  | { op: 'viewport' }
  /** Resolves once the DOM has been quiet for a moment (capped). */
  | { op: 'quiet' };

export type PageReply = { ok: true; value: unknown } | { ok: false; error: string };

/** What `describe` and `at-point` return: the element's ref, a short label, and its descriptor. */
export interface DescribedElement {
  ref: string;
  label: string;
  descriptor: ElementDescriptor;
}

export function pageScript(request: PageRequest): PageReply | Promise<PageReply> {
  type State = { tag: string; next: number; refs: Map<string, WeakRef<Element>>; ids: WeakMap<Element, string> };
  const host = window as unknown as { __hermod?: State };
  const state: State = (host.__hermod ??= {
    tag: Math.random().toString(36).slice(2, 4),
    next: 1,
    refs: new Map(),
    ids: new WeakMap(),
  });

  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const squash = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
  const quote = (text: string) => `"${text.replace(/"/g, "'")}"`;

  function refFor(el: Element): string {
    let ref = state.ids.get(el);
    if (!ref) {
      ref = `${state.tag}.${state.next++}`;
      state.ids.set(el, ref);
      state.refs.set(ref, new WeakRef(el));
    }
    return ref;
  }

  function byRef(ref: string): HTMLElement {
    if (!ref.startsWith(`${state.tag}.`)) throw new Error(`${ref} is from an earlier page. Call read_page or find to get refs for this one.`);
    const el = state.refs.get(ref)?.deref();
    if (!el || !el.isConnected) throw new Error(`${ref} is gone (the page changed). Call read_page or find again.`);
    return el as HTMLElement;
  }

  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'listbox', 'treeitem',
  ]);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'HEAD', 'META', 'LINK']);

  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0]!;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type;
      if (type === 'checkbox' || type === 'radio') return type;
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type === 'file') return 'file';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return `heading${tag[1]}`;
    if (tag === 'img') return 'img';
    if (tag === 'dialog') return 'dialog';
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    return 'generic';
  }

  function isVisible(el: Element): boolean {
    const check = (el as HTMLElement).checkVisibility?.({ visibilityProperty: true } as CheckVisibilityOptions);
    if (check === false) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isInteractive(el: Element): boolean {
    const tag = el.tagName;
    if (tag === 'INPUT') return (el as HTMLInputElement).type !== 'hidden';
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true;
    if (tag === 'A' && el.hasAttribute('href')) return true;
    if ((el as HTMLElement).isContentEditable && !(el.parentElement as HTMLElement | null)?.isContentEditable) return true;
    if (INTERACTIVE_ROLES.has(roleOf(el))) return true;
    if (el.hasAttribute('onclick')) return true;
    // Sites build buttons from divs with click listeners, which the DOM doesn't
    // show; a pointer cursor its parent doesn't have is the best hint.
    const cursor = getComputedStyle(el).cursor;
    return cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer');
  }

  function labelText(el: Element): string {
    const aria = el.getAttribute('aria-label');
    if (aria) return squash(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      if (squash(text)) return squash(text);
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) return squash(Array.from(labels).map((l) => l.innerText).join(' '));
    return squash(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt'));
  }

  function nameOf(el: Element): string {
    const label = labelText(el);
    if (label) return clip(label, 80);
    if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type)) return clip(squash(el.value), 80);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return clip(squash(el.name), 80);
    return clip(squash((el as HTMLElement).innerText), 80);
  }

  function stateOf(el: Element): string {
    const bits: string[] = [];
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) bits.push(el.checked ? 'checked' : 'unchecked');
    else if (el instanceof HTMLInputElement && el.type === 'password') bits.push(el.value ? 'value=(hidden)' : 'empty');
    else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (!['button', 'submit', 'reset', 'image', 'file'].includes(el.type)) bits.push(el.value ? `value=${quote(clip(squash(el.value), 60))}` : 'empty');
    } else if (el instanceof HTMLSelectElement) {
      bits.push(`selected=${quote(clip(squash(el.selectedOptions[0]?.text), 60))}`);
    } else if ((el as HTMLElement).isContentEditable) {
      const text = squash((el as HTMLElement).innerText);
      bits.push(text ? `text=${quote(clip(text, 60))}` : 'empty');
    }
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) bits.push(expanded === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true') bits.push('selected');
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
    if ((el as HTMLInputElement).required) bits.push('required');
    if (el instanceof HTMLAnchorElement && el.href) {
      const url = new URL(el.href, location.href);
      bits.push(`→ ${url.origin === location.origin ? url.pathname + url.search : `${url.host}${url.pathname}`}`.slice(0, 90));
    }
    return bits.join(' ');
  }

  function line(el: Element, withRef: boolean): string {
    const role = roleOf(el);
    const parts = [withRef ? `[${refFor(el)}]` : '', role === 'generic' ? 'clickable' : role, quote(nameOf(el)), stateOf(el)];
    return parts.filter(Boolean).join(' ');
  }

  function ownText(el: Element): string {
    let text = '';
    for (const node of Array.from(el.childNodes)) if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? '';
    return squash(text);
  }

  /** Visible elements in document order, open shadow roots included; hidden subtrees are skipped. */
  function walk(visit: (el: Element, depth: number) => boolean | void): void {
    const go = (root: Element | ShadowRoot, depth: number) => {
      for (const el of Array.from(root.children)) {
        if (SKIP.has(el.tagName) || el.getAttribute('aria-hidden') === 'true') continue;
        const style = getComputedStyle(el);
        if (style.display === 'none') continue;
        const shown = style.visibility !== 'hidden' && isVisible(el);
        const included = shown ? visit(el, depth) : false;
        const nextDepth = included ? depth + 1 : depth;
        if (el.shadowRoot) go(el.shadowRoot, nextDepth);
        go(el, nextDepth);
      }
    };
    if (document.body) go(document.body, 0);
  }

  function outline(filter: 'interactive' | 'all', maxChars: number): string {
    const header = [
      `${quote(clip(squash(document.title), 100))} ${location.href.slice(0, 200)}`,
      `Scrolled ${Math.round(scrollY)}px of ${document.documentElement.scrollHeight}px; viewport ${innerWidth}x${innerHeight}.`,
      '',
    ];
    const lines: string[] = [];
    let used = 0;
    let skipped = 0;
    let place: 'above' | 'in' | 'below' | undefined;
    walk((el, depth) => {
      const interactive = isInteractive(el);
      const role = roleOf(el);
      let text: string | undefined;
      if (interactive) text = line(el, true);
      else if (role.startsWith('heading') || role === 'dialog') text = `${role} ${quote(clip(squash((el as HTMLElement).innerText), 100))}`;
      else if (filter === 'all') {
        const own = ownText(el);
        if (own.length > 1) text = `text ${quote(clip(own, 200))}`;
        else if (role === 'img' && labelText(el)) text = `img ${quote(clip(labelText(el), 80))}`;
      }
      if (!text) return false;
      if (used > maxChars) {
        if (interactive) skipped++;
        return true;
      }
      const rect = el.getBoundingClientRect();
      const now = rect.bottom < 0 ? 'above' : rect.top > innerHeight ? 'below' : 'in';
      if (now !== place) {
        if (now === 'in' && place === 'above') lines.push('--- visible area ---');
        if (now === 'below' && place !== 'below') lines.push('--- below the visible area ---');
        if (now === 'above' && place === undefined) lines.push('--- above the visible area ---');
        place = now;
      }
      const entry = `${'  '.repeat(Math.min(depth, 6))}${text}`;
      lines.push(entry);
      used += entry.length + 1;
      return true;
    });
    if (!lines.length) lines.push('(nothing visible to show)');
    if (skipped) lines.push(`… ${skipped} more interactive elements not shown. Scroll, or use find.`);
    return [...header, ...lines].join('\n');
  }

  function find(query: string, limit: number): string {
    const needle = query.toLowerCase();
    const hits: { el: Element; interactive: boolean }[] = [];
    walk((el) => {
      const interactive = isInteractive(el);
      const role = roleOf(el);
      const text = interactive ? `${role} ${nameOf(el)} ${labelText(el)}` : role.startsWith('heading') ? (el as HTMLElement).innerText : ownText(el);
      if (text.toLowerCase().includes(needle)) hits.push({ el, interactive });
      return interactive;
    });
    if (!hits.length) return `Nothing on the page matches ${quote(query)}.`;
    hits.sort((a, b) => Number(b.interactive) - Number(a.interactive));
    const shown = hits.slice(0, limit).map(({ el, interactive }) =>
      interactive ? line(el, true) : `[${refFor(el)}] ${roleOf(el)} ${quote(clip(squash((el as HTMLElement).innerText), 120))}`,
    );
    return shown.join('\n') + (hits.length > limit ? `\n… ${hits.length - limit} more matches.` : '');
  }

  function shallow(el: Element): ElementDescriptor {
    const input = el as HTMLInputElement;
    return {
      tag: el.tagName.toLowerCase(),
      type: typeof input.type === 'string' ? input.type : undefined,
      role: roleOf(el),
      autocomplete: el.getAttribute('autocomplete') ?? undefined,
      name: el.getAttribute('name') ?? undefined,
      id: el.id || undefined,
      inputmode: el.getAttribute('inputmode') ?? undefined,
      label: labelText(el) || undefined,
      text: clip(el instanceof HTMLInputElement ? squash(input.value) : squash((el as HTMLElement).innerText), 120) || undefined,
    };
  }

  function describe(el: Element): DescribedElement {
    const descriptor = shallow(el);
    const form = (el as HTMLInputElement).form ?? el.closest('form');
    if (form) {
      const submitter = form.querySelector('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]');
      descriptor.form = {
        fields: Array.from(form.elements).slice(0, 60).map(shallow),
        submitter: submitter ? shallow(submitter) : undefined,
      };
    }
    return { ref: refFor(el), label: line(el, false), descriptor };
  }

  const CLICKABLE = 'a[href], button, input, select, textarea, summary, label, [role], [onclick], [tabindex], [contenteditable="true"]';

  function center(el: Element) {
    const rect = el.getBoundingClientRect();
    return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  }

  function click(el: HTMLElement): void {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const at = { bubbles: true, cancelable: true, composed: true, view: window, ...center(el) };
    el.dispatchEvent(new PointerEvent('pointerover', at));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...at, button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...at, button: 0, buttons: 1 }));
    if (el.matches('input, select, textarea, button, a[href], [tabindex]')) el.focus();
    el.dispatchEvent(new PointerEvent('pointerup', { ...at, button: 0, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...at, button: 0 }));
    el.click();
  }

  function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
    if (el instanceof HTMLTextAreaElement) return true;
    return el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden'].includes(el.type);
  }

  function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
  }

  function type(el: HTMLElement, text: string, clear: boolean): string {
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (isTextField(el)) {
      const expected = clear ? text : el.value + text;
      if (clear) el.select();
      else {
        try {
          el.setSelectionRange(el.value.length, el.value.length);
        } catch {
          // email and number inputs have no selection; typing still appends.
        }
      }
      // execCommand fires the input events editors and frameworks listen for;
      // setting the value directly is the fallback when it is refused.
      let inserted = false;
      try {
        inserted = text ? document.execCommand('insertText', false, text) : clear && document.execCommand('delete');
      } catch {
        inserted = false;
      }
      if (!inserted || el.value !== expected) setValue(el, expected);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return `The field now reads ${quote(clip(el.value, 80))}.`;
    }
    if (el.isContentEditable) {
      if (clear) document.execCommand('selectAll');
      else {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      }
      if (text) document.execCommand('insertText', false, text);
      else document.execCommand('delete');
      return `The field now reads ${quote(clip(squash(el.innerText), 80))}.`;
    }
    throw new Error(`${line(el, false)} is not a text field. Click it first, or find the field itself.`);
  }

  function select(el: HTMLElement, option: string): string {
    if (!(el instanceof HTMLSelectElement)) {
      throw new Error(`${line(el, false)} is not a <select>. For a custom dropdown, click it to open it, then click the option.`);
    }
    const wanted = option.trim().toLowerCase();
    const options = Array.from(el.options);
    const match =
      options.find((o) => o.value === option) ??
      options.find((o) => squash(o.text).toLowerCase() === wanted) ??
      options.find((o) => squash(o.text).toLowerCase().includes(wanted));
    if (!match) throw new Error(`No option ${quote(option)}. The options are: ${options.slice(0, 30).map((o) => quote(squash(o.text))).join(', ')}.`);
    el.focus();
    match.selected = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return `Selected ${quote(squash(match.text))}.`;
  }

  function tabbables(): HTMLElement[] {
    const all = Array.from(document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'));
    return all.filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && isVisible(el));
  }

  function scrollable(): Element {
    // Many apps scroll an inner pane instead of the page.
    if (document.documentElement.scrollHeight > innerHeight + 10) return document.scrollingElement ?? document.documentElement;
    const middle = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    for (let el = middle; el; el = el.parentElement) {
      const overflow = getComputedStyle(el).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 10) return el;
    }
    return document.scrollingElement ?? document.documentElement;
  }

  function scrollBy(amount: number | 'top' | 'bottom'): string {
    const target = scrollable();
    if (amount === 'top') target.scrollTop = 0;
    else if (amount === 'bottom') target.scrollTop = target.scrollHeight;
    else target.scrollTop += amount;
    return `Scrolled to ${Math.round(target.scrollTop)}px of ${target.scrollHeight}px.`;
  }

  const KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Space: { key: ' ', code: 'Space', keyCode: 32 },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    Home: { key: 'Home', code: 'Home', keyCode: 36 },
    End: { key: 'End', code: 'End', keyCode: 35 },
  };

  function press(name: PageKey, target: HTMLElement): string {
    const shift = name === 'Shift+Tab';
    const spec = KEYS[shift ? 'Tab' : name]!;
    const init = { ...spec, bubbles: true, cancelable: true, composed: true, shiftKey: shift, which: spec.keyCode };
    const proceed = target.dispatchEvent(new KeyboardEvent('keydown', init));
    if (name === 'Enter') target.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: 13 }));
    let effect = '';
    if (proceed) {
      if (name === 'Enter') {
        const form = (target as HTMLInputElement).form;
        if (target instanceof HTMLInputElement && form) {
          form.requestSubmit();
          effect = 'Submitted the form.';
        } else if (target.matches('button, a[href], summary, [role="button"], [role="link"]')) {
          target.click();
          effect = 'Activated it.';
        }
      } else if (name === 'Space' && target.matches('button, input[type="checkbox"], input[type="radio"], summary, [role="button"], [role="checkbox"]')) {
        target.click();
        effect = 'Activated it.';
      } else if (name === 'Tab' || name === 'Shift+Tab') {
        const list = tabbables();
        const next = list[(list.indexOf(target) + (shift ? -1 : 1) + list.length) % list.length];
        next?.focus();
        if (next) effect = `Focus moved to ${line(next, true)}.`;
      } else if ((name === 'ArrowDown' || name === 'ArrowUp') && target instanceof HTMLSelectElement) {
        target.selectedIndex = Math.max(0, Math.min(target.options.length - 1, target.selectedIndex + (name === 'ArrowDown' ? 1 : -1)));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        effect = `Selected ${quote(squash(target.selectedOptions[0]?.text))}.`;
      } else if ((name === 'Backspace' || name === 'Delete') && (isTextField(target) || target.isContentEditable)) {
        document.execCommand(name === 'Backspace' ? 'delete' : 'forwardDelete');
      } else if (!isTextField(target) && !target.isContentEditable) {
        const page = innerHeight * 0.8;
        const scroll = { PageDown: page, PageUp: -page, Space: page, ArrowDown: 60, ArrowUp: -60 } as Record<string, number>;
        if (name === 'Home' || name === 'End') effect = scrollBy(name === 'Home' ? 'top' : 'bottom');
        else if (scroll[name] !== undefined) effect = scrollBy(scroll[name]!);
      }
    }
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    return effect || `Pressed ${name}${proceed ? '' : ' (the page handled it)'}.`;
  }

  function quiet(): Promise<PageReply> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        observer.disconnect();
        clearTimeout(cap);
        resolve({ ok: true, value: true });
      };
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, 400);
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(done, 400);
      const cap = setTimeout(done, 2500);
    });
  }

  try {
    switch (request.op) {
      case 'outline':
        return { ok: true, value: outline(request.filter, request.maxChars) };
      case 'text': {
        const text = (document.body?.innerText ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        const clipped = text.length > request.maxChars ? `${text.slice(0, request.maxChars)}\n…(${text.length - request.maxChars} more characters)` : text;
        return { ok: true, value: `${quote(clip(squash(document.title), 100))} ${location.href.slice(0, 200)}\n\n${clipped || '(no readable text)'}` };
      }
      case 'find':
        return { ok: true, value: find(request.query, request.limit) };
      case 'describe':
        return { ok: true, value: describe(byRef(request.ref)) };
      case 'at-point': {
        const hit = document.elementFromPoint(request.x, request.y);
        if (!hit) throw new Error(`Nothing at ${Math.round(request.x)},${Math.round(request.y)} on the page.`);
        return { ok: true, value: describe(hit.closest(CLICKABLE) ?? hit) };
      }
      case 'click':
        click(byRef(request.ref));
        return { ok: true, value: null };
      case 'type':
        return { ok: true, value: type(byRef(request.ref), request.text, request.clear) };
      case 'select':
        return { ok: true, value: select(byRef(request.ref), request.option) };
      case 'key': {
        const target = request.ref ? byRef(request.ref) : ((document.activeElement as HTMLElement | null) ?? document.body);
        if (request.ref) target.focus();
        return { ok: true, value: press(request.key, target) };
      }
      case 'scroll': {
        if (request.ref) {
          const el = byRef(request.ref);
          el.scrollIntoView({ block: 'center' });
          return { ok: true, value: `Scrolled ${line(el, true)} into view.` };
        }
        const page = innerHeight * 0.8;
        const amounts = { up: -page, down: page, top: 'top', bottom: 'bottom' } as const;
        return { ok: true, value: scrollBy(amounts[request.direction ?? 'down']) };
      }
      case 'has': {
        if (request.ref) {
          const el = state.refs.get(request.ref)?.deref();
          return { ok: true, value: !!el?.isConnected && isVisible(el) };
        }
        return { ok: true, value: (document.body?.innerText ?? '').toLowerCase().includes((request.text ?? '').toLowerCase()) };
      }
      case 'viewport':
        return { ok: true, value: { dpr: devicePixelRatio, width: innerWidth, height: innerHeight } };
      case 'quiet':
        return quiet();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
