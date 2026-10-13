// The status dot on Hermod's toolbar icon: pulsing while an agent works
// (amber when it waits on the user), solid green or red when a thread has a
// result the user hasn't seen. Frames are drawn once per state and cycled.
import type { ThreadActivity } from './run';

const SIZES = [16, 32] as const;
const PULSE = [1, 0.85, 0.65, 0.45, 0.35, 0.45, 0.65, 0.85];
const FRAME_MS = 150;
// The theme's clay, amber, sage and bad colours.
const COLOURS: Record<ThreadActivity, string> = { running: '#b6613f', waiting: '#b08d3c', done: '#6f8a78', failed: '#b45c43' };
// Most urgent first: what the toolbar shows when threads differ.
const URGENCY: ThreadActivity[] = ['waiting', 'running', 'failed', 'done'];

type IconFrame = Record<number, ImageData>;

let icons: Promise<Record<number, ImageBitmap>> | undefined;
const frames = new Map<ThreadActivity, IconFrame[]>();
let shown: ThreadActivity | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

function loadIcons(): Promise<Record<number, ImageBitmap>> {
  icons ??= Promise.all(
    SIZES.map(async (size) => [size, await createImageBitmap(await (await fetch(browser.runtime.getURL(`/icon/${size}.png`))).blob())] as const),
  ).then(Object.fromEntries);
  return icons;
}

function draw(icon: ImageBitmap, size: number, colour: string, alpha: number): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(icon, 0, 0, size, size);
  const r = size * 0.22;
  const x = size - r - size * 0.03;
  const y = size - r - size * 0.03;
  // Cut a ring out of the icon so the dot reads on any toolbar colour.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(x, y, r + size * 0.07, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

async function framesFor(activity: ThreadActivity): Promise<IconFrame[]> {
  const cached = frames.get(activity);
  if (cached) return cached;
  const base = await loadIcons();
  const alphas = activity === 'running' || activity === 'waiting' ? PULSE : [1];
  const made = alphas.map((alpha) => Object.fromEntries(SIZES.map((size) => [size, draw(base[size]!, size, COLOURS[activity], alpha)])));
  frames.set(activity, made);
  return made;
}

/** The state the toolbar should show for all threads together. */
export function overallActivity(activity: Record<string, ThreadActivity>): ThreadActivity | null {
  const present = new Set(Object.values(activity));
  return URGENCY.find((a) => present.has(a)) ?? null;
}

export async function showActivity(next: ThreadActivity | null): Promise<void> {
  if (next === shown) return;
  shown = next;
  clearInterval(timer);
  timer = undefined;
  try {
    if (!next) {
      await browser.action.setIcon({ path: Object.fromEntries(SIZES.map((size) => [size, `/icon/${size}.png`])) });
      return;
    }
    const cycle = await framesFor(next);
    if (shown !== next) return;
    let i = 0;
    const tick = () => void browser.action.setIcon({ imageData: cycle[i++ % cycle.length]! }).catch(() => {});
    tick();
    if (cycle.length > 1) timer = setInterval(tick, FRAME_MS);
  } catch (err) {
    // The dot is a convenience; a browser that can't draw it still runs commands.
    console.warn('[hermod] could not update the toolbar icon', err);
  }
}
