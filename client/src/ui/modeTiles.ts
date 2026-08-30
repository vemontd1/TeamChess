import { sfx } from '../audio/sfx';

/**
 * The mode picker, as two tiles rather than two words in a segmented control.
 *
 * Choosing a mode is the first decision anybody makes here and the only one that changes
 * what the game *is*, so it is the one control on the home screen worth giving room to.
 * A segmented control gave it the same weight as the player count.
 *
 * The art is inline SVG, drawn from the same shapes the game already uses -- a rank of
 * pieces standing together for the team game, a fanned hand with pieces on the faces for
 * the card game. Inline because two illustrations are not worth a network request, and
 * because they inherit the accent and dim with the tile they sit in.
 */

export interface ModeTile {
  value: string;
  title: string;
  blurb: string;
  art: string;
}

/** A rank of pieces, shoulder to shoulder: one side, several people. */
const TEAM_ART = `
<svg viewBox="0 0 120 64" aria-hidden="true" class="mt-art">
  <defs>
    <linearGradient id="mt-team-g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="currentColor" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="currentColor" stop-opacity="0.45"/>
    </linearGradient>
  </defs>
  <g fill="url(#mt-team-g)">
    <!-- three pawns and a king, standing in a line -->
    <path d="M22 52h14c0-5-3-7-4-9 2-1 3-3 3-5a6 6 0 1 0-12 0c0 2 1 4 3 5-1 2-4 4-4 9Z"/>
    <path d="M42 52h14c0-5-3-7-4-9 2-1 3-3 3-5a6 6 0 1 0-12 0c0 2 1 4 3 5-1 2-4 4-4 9Z"/>
    <path d="M82 52h14c0-5-3-7-4-9 2-1 3-3 3-5a6 6 0 1 0-12 0c0 2 1 4 3 5-1 2-4 4-4 9Z"/>
    <path d="M62 52h16c0-6-3-9-5-11 3-2 4-4 4-7 0-3-2-5-5-6V25h-3v-3h-4v3h-3v3c-3 1-5 3-5 6
             0 3 1 5 4 7-2 2-5 5-5 11Z"/>
  </g>
  <rect x="14" y="54" width="92" height="3" rx="1.5" fill="currentColor" opacity="0.35"/>
</svg>`;

/** A fanned hand, each card carrying a piece: the duel over what you may move. */
const CARDS_ART = `
<svg viewBox="0 0 120 64" aria-hidden="true" class="mt-art">
  <g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
    <g transform="rotate(-16 60 60)">
      <rect x="30" y="14" width="26" height="38" rx="4" fill="currentColor" fill-opacity="0.10"/>
    </g>
    <g transform="rotate(16 60 60)">
      <rect x="64" y="14" width="26" height="38" rx="4" fill="currentColor" fill-opacity="0.10"/>
    </g>
    <rect x="47" y="9" width="26" height="38" rx="4" fill="currentColor" fill-opacity="0.16"/>
  </g>
  <g fill="currentColor">
    <!-- a knight's head on the near card, a pawn on the left, a crown on the right -->
    <path d="M56 38c0-6 2-8 4-10-1-2-1-4 1-5l2 3 3-1c3 2 4 5 4 9v4Z" opacity="0.95"/>
    <path d="M35 40h8c0-3-2-4-2-5 1-1 2-2 2-3a4 4 0 1 0-8 0c0 1 1 2 2 3 0 1-2 2-2 5Z"
          opacity="0.7" transform="rotate(-16 60 60)"/>
    <path d="M78 32l2 6h8l2-6-3 2-3-4-3 4Z" opacity="0.7" transform="rotate(16 60 60)"/>
  </g>
</svg>`;

export const MODE_TILES: ModeTile[] = [
  {
    value: 'team',
    title: 'Team Chess',
    blurb: 'Your team shares one side. Teammates move in turn, and the clock waits for '
      + 'nobody.',
    art: TEAM_ART,
  },
  {
    value: 'cards',
    title: 'Chess Cards',
    blurb: 'One against one. You may only move a piece you hold a card for — the king '
      + 'excepted, and he is always free.',
    art: CARDS_ART,
  },
];

export interface ModeTilesOptions {
  value: string;
  onChange: (value: string) => void;
}

export class ModeTiles {
  readonly el: HTMLElement;
  private value: string;
  private opts: ModeTilesOptions;

  constructor(opts: ModeTilesOptions) {
    this.opts = opts;
    this.value = opts.value;

    this.el = document.createElement('div');
    this.el.className = 'mode-tiles';
    this.el.setAttribute('role', 'radiogroup');
    this.el.setAttribute('aria-label', 'Game mode');
    this.el.innerHTML = MODE_TILES.map(t => `
      <button type="button" class="mode-tile" role="radio" data-mode="${t.value}"
        aria-checked="${t.value === this.value}">
        <span class="mt-figure">${t.art}</span>
        <span class="mt-title">${t.title}</span>
        <span class="mt-blurb">${t.blurb}</span>
      </button>`).join('');

    this.el.querySelectorAll<HTMLButtonElement>('.mode-tile').forEach(btn => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.mode!;
        if (next === this.value) return;
        this.set(next);
        sfx.click();
        this.opts.onChange(next);
      });
    });
  }

  get selected(): string { return this.value; }

  set(value: string): void {
    this.value = value;
    this.el.querySelectorAll<HTMLElement>('.mode-tile').forEach(btn => {
      btn.setAttribute('aria-checked', String(btn.dataset.mode === value));
    });
  }
}
