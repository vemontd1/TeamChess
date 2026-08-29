import { effectsEnabled } from '../state/motion';

/**
 * "It's your move" announcement.
 *
 * A player waiting through a rotation of teammates is very likely looking somewhere else,
 * so this has to reach them peripherally rather than rewarding a stare at the board: an
 * amber bloom sweeps in from the screen edges, the board pulses, and a title rises and
 * clears itself. Everything is pointer-transparent and self-removing, so it can never trap
 * a click or leave residue if a move lands mid-animation.
 *
 * With effects disabled it degrades to a static edge tint plus the title, which still says
 * "your turn" without any sweeping motion.
 */

let host: HTMLElement | null = null;
let hideTimer = 0;

function ensureHost(): HTMLElement {
  if (!host) {
    host = document.createElement('div');
    host.className = 'turn-alert';
    host.setAttribute('aria-live', 'assertive');
    document.body.appendChild(host);
  }
  return host;
}

export function showTurnAlert(playerName: string | null, boardEl?: HTMLElement | null): void {
  const el = ensureHost();
  const reduced = !effectsEnabled();

  el.className = `turn-alert show${reduced ? ' reduced' : ''}`;
  el.innerHTML = `
    <div class="turn-vignette"></div>
    <div class="turn-title">
      <span class="turn-kicker">your move</span>
      ${playerName ? `<span class="turn-name">${escape(playerName)}</span>` : ''}
    </div>`;

  // the board gets its own pulse so the eye is pulled to where the action is
  if (boardEl) {
    boardEl.classList.remove('board-turn-pulse');
    void boardEl.offsetWidth;            // reflow, so re-adding restarts the animation
    boardEl.classList.add('board-turn-pulse');
    window.setTimeout(() => boardEl.classList.remove('board-turn-pulse'), 1400);
  }

  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    el.classList.remove('show');
  }, reduced ? 1600 : 1900);
}

/** Pull the announcement immediately — used when the turn ends early. */
export function clearTurnAlert(): void {
  clearTimeout(hideTimer);
  host?.classList.remove('show');
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}
