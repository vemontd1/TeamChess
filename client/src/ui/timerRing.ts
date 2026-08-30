import { sfx } from '../audio/sfx';
import { FireRing } from './fireRing';

const BOX = 152;
const R = 64;
const CIRC = 2 * Math.PI * R;

/**
 * Countdown ring, with a particle fire burning down the remaining arc.
 *
 * The server sends both an absolute deadline and the time left on its own clock. Only the
 * duration is trusted: it is converted once, on arrival, into a deadline on *this*
 * machine's clock. Subtracting the server's epoch from a local `Date.now()` looks correct
 * until the two clocks disagree -- the deployed host ran half a minute behind a player's
 * PC, which made every countdown expire before it was drawn, so the ring sat at zero for
 * the whole game and no warning ever sounded.
 *
 * The local deadline is re-read against `Date.now()` every frame rather than decremented,
 * so a throttled background tab or a slow frame still cannot drift.
 *
 * Re-syncing happens only when the server's deadline value actually changes -- a new turn
 * or a re-armed clock. Every unrelated re-render (a chat line, a mark) carries the same
 * snapshot, and resyncing on those would rewind the countdown a few frames at a time.
 */
export class TimerRing {
  readonly el: HTMLElement;
  private bar: SVGCircleElement;
  private num: HTMLElement;
  private label: HTMLElement;
  private ring: HTMLElement;
  private fire: FireRing;
  private sizeObs: ResizeObserver | null = null;
  private raf = 0;
  /** The server's own value, kept only to notice when the turn changes. */
  private serverDeadline: number | null = null;
  /** The same moment expressed on this machine's clock -- what the countdown reads. */
  private deadline: number | null = null;
  private totalMs = 0;
  private lastWholeSecond = -1;
  private soundOn = true;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'timer-wrap';
    this.el.innerHTML = `
      <div class="timer-ring">
        <svg viewBox="0 0 ${BOX} ${BOX}">
          <defs>
            <linearGradient id="fuse" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stop-color="#FFD98A"/>
              <stop offset="100%" stop-color="#E8B04B"/>
            </linearGradient>
          </defs>
          <circle class="ring-track" cx="${BOX / 2}" cy="${BOX / 2}" r="${R}"></circle>
          <circle class="ring-bar" cx="${BOX / 2}" cy="${BOX / 2}" r="${R}"
                  stroke-dasharray="${CIRC}" stroke-dashoffset="0"></circle>
        </svg>
        <div class="timer-face">
          <div class="timer-num">--</div>
          <div class="timer-label">on the clock</div>
        </div>
      </div>
      <div class="timer-who"></div>`;

    this.ring = this.el.querySelector('.timer-ring')!;
    this.bar = this.el.querySelector('.ring-bar')!;
    this.num = this.el.querySelector('.timer-num')!;
    this.label = this.el.querySelector('.timer-label')!;

    this.fire = new FireRing(BOX, R);
    this.ring.insertBefore(this.fire.canvas, this.ring.firstChild);

    // The ring is sized in CSS from `--ui`, so its pixel size is not BOX on every display.
    // Measuring it is the only thing that stays true across scale steps, a window resize
    // and a browser zoom -- and getting it wrong put the fire beside the clock, not on it.
    if (typeof ResizeObserver !== 'undefined') {
      this.sizeObs = new ResizeObserver(entries => {
        const w = entries[0]?.contentRect.width ?? 0;
        if (w > 0) this.fire.setDisplaySize(w);
      });
      this.sizeObs.observe(this.ring);
    }
  }

  setSound(on: boolean): void { this.soundOn = on; }

  /**
   * A null deadline means no clock is running -- either an untimed game, a game not in
   * progress, or a turn paused mid-takeback. `paused` distinguishes the last so a held
   * clock does not read as a full one.
   */
  update(deadline: number | null, remainingMs: number | null, totalSec: number | null,
         who: string | null, teamLabel: string, paused = false): void {
    if (deadline !== this.serverDeadline) {
      this.serverDeadline = deadline;
      this.deadline = deadline == null ? null : Date.now() + (remainingMs ?? 0);
      this.lastWholeSecond = -1;
    }
    this.totalMs = (totalSec ?? 0) * 1000;

    const whoEl = this.el.querySelector('.timer-who')!;
    whoEl.innerHTML = who
      ? `<b>${escapeHtml(who)}</b>${escapeHtml(teamLabel)}`
      : `<span class="timer-team-idle">${escapeHtml(teamLabel)}</span>`;

    if (this.deadline == null) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.fire.clear();
      this.bar.style.strokeDashoffset = '0';
      this.ring.className = `timer-ring${paused ? ' paused' : ''}`;
      this.num.textContent = paused ? '❙❙' : totalSec == null ? '∞' : '--';
      this.label.textContent = paused ? 'clock held' : totalSec == null ? 'no limit' : 'on the clock';
      this.lastWholeSecond = -1;
      return;
    }

    this.label.textContent = 'on the clock';
    this.fire.start();
    if (!this.raf) this.tick();
  }

  private tick = (): void => {
    if (this.deadline == null) { this.raf = 0; return; }

    const remaining = Math.max(0, this.deadline - Date.now());
    const frac = this.totalMs > 0 ? remaining / this.totalMs : 0;

    this.bar.style.strokeDashoffset = String(CIRC * (1 - frac));
    this.fire.setProgress(frac);

    const secs = Math.ceil(remaining / 1000);
    if (secs !== this.lastWholeSecond) {
      this.num.textContent = format(remaining);
      // One beep per whole second over the last ten, climbing in pitch and volume as the
      // clock closes. The first tick after a resync is skipped: it lands on whatever
      // fraction of a second the snapshot arrived in, not on a real boundary.
      // Zero itself is silent here: the server's timeout broadcast carries the
      // explosion, so a local blip at the same instant would only muddy it.
      if (this.soundOn && this.lastWholeSecond >= 0 && secs > 0) {
        if (secs <= 3) sfx.tickFinal();
        else if (secs <= 5) sfx.tickUrgent();
        else if (secs <= 10) sfx.tick();
      }
      this.lastWholeSecond = secs;
    }

    this.ring.className = 'timer-ring lit'
      + (frac <= 0.15 ? ' urgent' : frac <= 0.25 ? ' warn' : '');

    if (remaining <= 0) this.fire.stop();

    this.raf = requestAnimationFrame(this.tick);
  };

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.sizeObs?.disconnect();
    this.sizeObs = null;
    this.fire.destroy();
  }
}

function format(ms: number): string {
  const total = Math.ceil(ms / 1000);
  if (total >= 60) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  return String(total);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}
