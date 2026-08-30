import { motionLevel } from '../state/motion';

/**
 * The sacrifice: blood at the edges of the screen.
 *
 * Burning three cards to force one move is the most expensive thing a player can do, and
 * it happened in near silence -- three cards left the hand and a piece moved, which from
 * across the board looked like an ordinary turn. This is the cost made visible, and it is
 * deliberately the only red the interface ever goes: everything else here is amber.
 *
 * Built the way `turnAlert` is, for the same reasons. A fixed, pointer-transparent host
 * over everything, so it can never trap a click; a single element that replaces itself,
 * so a second sacrifice cannot stack two of them; and it removes itself on a timer rather
 * than on `animationend`, which never fires if the tab is backgrounded mid-animation.
 *
 * Four layers, in the order they are read:
 *   1. a flash over everything that says *now*
 *   2. a heavy rim at the edges that says *this cost you*
 *   3. runs reaching down from the top edge, each with its own delay and length
 *   4. a brief spatter, thrown from the centre outwards
 *
 * Reduced motion keeps the vignette -- the player still has to be told what they just paid
 * -- and drops the runs and the spatter, which are the parts that move unpredictably.
 */

const LIFE_MS = 2200;
/** Calm does not animate at all, so it is shown and cut rather than left to fade. */
const CALM_LIFE_MS = 1100;

let host: HTMLElement | null = null;
let clearTimer = 0;

function ensureHost(): HTMLElement {
  if (!host) {
    host = document.createElement('div');
    host.className = 'blood';
    host.setAttribute('aria-hidden', 'true');
    document.body.appendChild(host);
  }
  return host;
}

/** Runs of blood down from the top edge, at irregular widths and speeds. */
function runs(count: number): string {
  let out = '';
  for (let i = 0; i < count; i++) {
    const left = (i + 0.5) / count * 100 + (Math.random() - 0.5) * (60 / count);
    const width = 3 + Math.random() * 7;
    const reach = 12 + Math.random() * 26;
    const delay = Math.random() * 260;
    const dur = 900 + Math.random() * 700;
    out += `<span class="blood-run" style="
      left:${left.toFixed(2)}%; width:${width.toFixed(1)}px;
      --reach:${reach.toFixed(0)}vh; --delay:${delay.toFixed(0)}ms;
      --dur:${dur.toFixed(0)}ms"></span>`;
  }
  return out;
}

/** Droplets thrown outward from the middle of the screen. */
function spatter(count: number): string {
  let out = '';
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 18 + Math.random() * 42;
    const size = 4 + Math.random() * 13;
    out += `<span class="blood-drop" style="
      --dx:${(Math.cos(angle) * dist).toFixed(1)}vw;
      --dy:${(Math.sin(angle) * dist).toFixed(1)}vh;
      --size:${size.toFixed(1)}px;
      --delay:${(Math.random() * 180).toFixed(0)}ms"></span>`;
  }
  return out;
}

/**
 * Play it. `own` is whether this browser paid the cost -- your own sacrifice hits harder
 * than watching someone else make one, which is the honest weighting: one of them cost
 * you three cards.
 */
export function showBloodBurst(own: boolean): void {
  const level = motionLevel();
  if (level === 'off') return;

  const el = ensureHost();
  const calm = level === 'calm';

  el.className = `blood show${own ? ' own' : ''}${calm ? ' calm' : ''}`;
  el.innerHTML = `
    <div class="blood-flash"></div>
    <div class="blood-vignette"></div>
    ${calm ? '' : `<div class="blood-runs">${runs(own ? 9 : 5)}</div>`}
    ${calm ? '' : `<div class="blood-spatter">${spatter(own ? 16 : 8)}</div>`}`;

  window.clearTimeout(clearTimer);
  clearTimer = window.setTimeout(() => {
    if (!host) return;
    host.className = 'blood';
    host.innerHTML = '';
  }, calm ? CALM_LIFE_MS : LIFE_MS);
}

export function clearBloodBurst(): void {
  window.clearTimeout(clearTimer);
  if (host) { host.className = 'blood'; host.innerHTML = ''; }
}
