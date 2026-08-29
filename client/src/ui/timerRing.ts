import { sfx } from '../audio/sfx';
import { FireRing } from './fireRing';

const BOX = 152;
const R = 64;
const CIRC = 2 * Math.PI * R;

/**
 * Countdown ring driven off the server's absolute deadline, with a particle fire
 * burning down the remaining arc.
 *
 * It re-reads `Date.now()` against that deadline every frame rather than decrementing a
 * local counter, so a throttled background tab or a slow frame cannot desynchronise it
 * from the server that will actually fire the timeout.
 */
export class TimerRing {
  readonly el: HTMLElement;
  private bar: SVGCircleElement;
  private num: HTMLElement;
  private label: HTMLElement;
  private ring: HTMLElement;
  private fire: FireRing;
  private raf = 0;
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
  }

  setSound(on: boolean): void { this.soundOn = on; }

  /**
   * A null deadline means no clock is running -- either an untimed game, a game not in
   * progress, or a turn paused mid-takeback. `paused` distinguishes the last so a held
   * clock does not read as a full one.
   */
  update(deadline: number | null, totalSec: number | null, who: string | null,
         teamLabel: string, paused = false): void {
    this.deadline = deadline;
    this.totalMs = (totalSec ?? 0) * 1000;

    const whoEl = this.el.querySelector('.timer-who')!;
    whoEl.innerHTML = who
      ? `<b>${escapeHtml(who)}</b>${escapeHtml(teamLabel)}`
      : `<span class="timer-team-idle">${escapeHtml(teamLabel)}</span>`;

    if (deadline == null) {
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
      // one beep per whole second inside the final stretch, never a stream of them
      if (this.soundOn && this.lastWholeSecond >= 0 && secs > 0) {
        if (secs <= 5) sfx.tickUrgent();
        else if (frac <= 0.25 && secs <= 10) sfx.tick();
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
