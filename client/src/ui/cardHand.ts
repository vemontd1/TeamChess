import { pieceSvg, type PieceCode } from '../board/pieces';
import { escapeHtml } from './timerRing';
import { motionLevel, onMotionChange, type MotionLevel } from '../state/motion';
import type { CardKind, HandState, CardsPublic, Color } from '../types';

/** The card ids the server reserves. A negative id is not a card in anyone's deck. */
export const EMERGENCY_CARD_ID = -1;

const KIND_PIECE: Record<CardKind, string> = {
  pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', wild: '',
};

const KIND_LABEL: Record<CardKind, string> = {
  pawn: 'Pawn', knight: 'Knight', bishop: 'Bishop', rook: 'Rook', queen: 'Queen',
  wild: 'Wild',
};

/** The corner mark, the way a playing card carries its rank in the corner. */
const KIND_PIP: Record<CardKind, string> = {
  pawn: 'P', knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', wild: '★',
};

/** How a kind reads when the piece is spoken of as a group. */
const KIND_PLURAL: Record<CardKind, string> = {
  pawn: 'pawns', knight: 'knights', bishop: 'bishops', rook: 'rooks', queen: 'queens',
  wild: 'pieces',
};

/** Hand order, so a drawn card slots into place instead of landing wherever. */
const KIND_ORDER: CardKind[] = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'wild'];

/** Every piece a card unlocks. Wild reaches all of them; the king never needs one. */
export function typesForKind(kind: CardKind): string[] {
  return kind === 'wild' ? ['p', 'n', 'b', 'r', 'q'] : [KIND_PIECE[kind]];
}

/**
 * The piece types a hand can pay for, plus the king, which is always free.
 *
 * This is what the board is narrowed to when no card is picked: everything the player
 * could legally set in motion right now. Picking a card narrows it further.
 */
export function reachOf(hand: HandState | null): Set<string> | null {
  if (!hand) return null;
  const out = new Set<string>(['k']);
  if (hand.emergency) { for (const t of 'pnbrq') out.add(t); return out; }
  for (const c of hand.cards) {
    if (!c.playable) continue;
    for (const t of typesForKind(c.kind)) out.add(t);
  }
  return out;
}

export interface CardHandHandlers {
  /** A card was picked or unpicked; null means "let the server choose". */
  onSelect: (cardId: number | null) => void;
  onMulligan: () => void;
  /** Preview the reach of a card under the cursor, without committing to it. */
  onHover: (cardId: number | null) => void;
  /** Cards arrived in the hand -- one cue for the batch, never one per card. */
  onDeal?: (count: number) => void;
}

interface Slot { id: number; kind: CardKind; playable: boolean; emergency: boolean }

const DEAL_STAGGER_MS = 70;
const EXIT_MS = 420;

/**
 * The hand, the opponent's card count, and both discard piles.
 *
 * Cards are the mode's only hidden information, so this panel is careful about which of
 * it is yours: your hand is drawn face up with each card marked live or dead against the
 * position, and the opponent is shown as a count of backs plus the face-up record of what
 * they have already spent. Section 14 of the design doc makes reading that record part of
 * the skill, so it is not tucked away.
 *
 * Cards are reconciled rather than redrawn. The panel re-renders on every broadcast --
 * every opponent move, every clock tick that changes state -- and rebuilding the markup
 * would restart every animation on each one, so a card that is still in your hand keeps
 * its element and only its classes change. A card element therefore appears exactly when
 * it is drawn and leaves exactly when it is spent, which is what makes those two moments
 * animatable at all.
 *
 * Position comes from the flex `order` property rather than DOM order, because moving a
 * node re-inserts it and re-inserting restarts its animation -- so a card drawn into the
 * middle of the hand would otherwise re-deal every card to its right.
 */
export class CardHand {
  /** The hand itself, which belongs under the board where the doc puts it. */
  readonly el: HTMLElement;
  /**
   * The table: what the opponent holds, and what both sides have spent.
   *
   * This lives in a side column rather than between the board and the hand. It is
   * reference material -- read between turns, not during a move -- and a hundred pixels
   * of it stacked under the board was costing the board a hundred pixels of size, which
   * is the one thing on screen that cannot be read anywhere else.
   */
  readonly infoEl: HTMLElement;
  private handEl: HTMLElement;
  private actionsEl: HTMLElement;
  private oppEl: HTMLElement;
  private noteEl: HTMLElement;
  private handlers: CardHandHandlers;
  private selectedId: number | null = null;
  private hand: HandState | null = null;
  private cardEls = new Map<number, HTMLElement>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private offMotion: () => void;

  constructor(handlers: CardHandHandlers) {
    this.handlers = handlers;
    this.el = document.createElement('div');
    this.el.className = 'cards-wrap';
    this.el.innerHTML = `
      <div class="cards-note" id="note" role="status" aria-live="polite"></div>
      <div class="cards-row">
        <div class="cards-hand" id="hand" role="group" aria-label="Your cards"></div>
        <div class="cards-actions" id="actions"></div>
      </div>`;
    this.handEl = this.el.querySelector('#hand')!;
    this.actionsEl = this.el.querySelector('#actions')!;
    this.noteEl = this.el.querySelector('#note')!;

    this.infoEl = document.createElement('section');
    this.infoEl.className = 'panel edge cards-table';
    this.infoEl.innerHTML = `
      <div class="panel-head"><span class="panel-title">The table</span></div>
      <div class="cards-opp" id="opp"></div>`;
    this.oppEl = this.infoEl.querySelector('#opp')!;

    this.paintMotion(motionLevel());
    this.offMotion = onMotionChange(lvl => this.paintMotion(lvl));
  }

  /**
   * The looping, decorative animations -- the Wild's shimmer, the emergency throb -- are
   * the ones the effects toggle governs. Deal and spend stay: they are how the player
   * sees a card arrive or leave, not decoration on top of it.
   */
  private paintMotion(level: MotionLevel): void {
    for (const el of [this.el, this.infoEl]) {
      el.classList.toggle('fx-full', level === 'full');
      el.classList.toggle('fx-calm', level === 'calm');
      el.classList.toggle('fx-off', level === 'off');
    }
  }

  /** Long enough to cover the deal animation plus the glow that outlasts it. */
  private static readonly DEAL_MS = 800;

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  /** The card the player picked, if any. The server chooses when this is null. */
  selection(): number | null { return this.selectedId; }

  /** Board reach for the current pick, or for the whole hand when nothing is picked. */
  reach(): Set<string> | null {
    if (!this.hand) return null;
    if (this.selectedId == null) return reachOf(this.hand);
    if (this.selectedId === EMERGENCY_CARD_ID) {
      return new Set(['k', 'p', 'n', 'b', 'r', 'q']);
    }
    const card = this.hand.cards.find(c => c.id === this.selectedId);
    if (!card) return reachOf(this.hand);
    return new Set(['k', ...typesForKind(card.kind)]);
  }

  /** Drop the pick -- after a move lands, or when the turn passes. */
  clearSelection(): void {
    if (this.selectedId == null) return;
    this.selectedId = null;
    this.handlers.onSelect(null);
    this.repaintSelection();
  }

  render(hand: HandState | null, cards: CardsPublic | null, myColor: Color | null): void {
    const hadHand = this.hand != null;
    this.hand = hand;

    // a pick cannot outlive the card it named, or the turn it was made in
    if (this.selectedId != null && hand) {
      const stillThere = this.selectedId === EMERGENCY_CARD_ID
        ? hand.emergency
        : hand.cards.some(c => c.id === this.selectedId && c.playable);
      if (!stillThere || !hand.yourTurn) this.selectedId = null;
    }

    this.el.classList.toggle('hand-live', hand?.yourTurn === true);
    this.infoEl.classList.toggle('hand-live', hand?.yourTurn === true);
    this.renderOpponent(cards, myColor);
    this.renderNote(hand);
    this.reconcileHand(hand, hadHand);
    this.renderActions(hand);
  }

  // ---- the opponent's side of the table ----

  private renderOpponent(cards: CardsPublic | null, myColor: Color | null): void {
    if (!cards) { this.oppEl.innerHTML = ''; return; }
    const oppColor: Color = myColor === 'white' ? 'black' : 'white';
    const opp = cards[oppColor];
    const me = myColor ? cards[myColor] : null;

    // The backs are staggered on entry too, so an opponent drawing is visible as motion
    // on their side of the table rather than as a number quietly changing.
    const backs = Array.from({ length: opp.handCount },
      (_, i) => `<span class="card-back" style="--i:${i}"></span>`).join('');

    this.oppEl.innerHTML = `
      <div class="opp-row">
        <span class="opp-label">${oppColor === 'white' ? 'White' : 'Black'} holds</span>
        <span class="opp-backs">${backs || '<span class="opp-none">nothing</span>'}</span>
        <span class="opp-count">${opp.handCount}</span>
      </div>
      <div class="spent-row">
        <span class="spent-label">Spent</span>
        ${spentStrip(opp.played, oppColor)}
      </div>
      ${me ? `<div class="spent-row spent-mine">
        <span class="spent-label">Yours</span>
        ${spentStrip(me.played, myColor!)}
      </div>` : ''}
      <div class="cards-meta">
        <span title="Cards left in your draw pile">Deck ${me ? me.deckCount : opp.deckCount}</span>
        <span title="Cards drawn at the start of each turn">Draw to ${cards.drawTarget}</span>
        ${cards.enraged
          ? '<span class="meta-hot" title="Twenty plies in: both sides draw one more">Enraged</span>'
          : ''}
      </div>`;
  }

  private renderNote(hand: HandState | null): void {
    const set = (cls: string, text: string): void => {
      if (this.noteEl.textContent === text) return;   // don't re-announce an unchanged line
      this.noteEl.className = `cards-note ${cls}`;
      this.noteEl.textContent = text;
    };
    if (!hand) { set('', ''); return; }
    if (!hand.yourTurn) { set('', 'Waiting for your opponent…'); return; }
    if (hand.emergency) {
      set('note-emergency',
        'No card in your hand can move anything — take the emergency move.');
      return;
    }
    // A card swapped out for a piece you no longer own is a rule the player cannot see
    // happening, so it says so on the turn it happens rather than leaving them to notice
    // a card they were holding has quietly become a different one.
    if (hand.replaced.length > 0) {
      const kinds = [...new Set(hand.replaced)].map(k => KIND_PLURAL[k]);
      set('note-swap', `No ${listOf(kinds)} left on the board — `
        + `${hand.replaced.length > 1 ? 'those cards were' : 'that card was'} replaced.`);
      return;
    }
    set('note-live', 'Play a card, or just move — the matching card is spent.');
  }

  // ---- the hand itself ----

  /** What the hand should hold, in the order it should read, emergency last. */
  private slotsFor(hand: HandState | null): Slot[] {
    if (!hand) return [];
    const slots: Slot[] = hand.cards.map(c => ({ ...c, emergency: false }));
    slots.sort((a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.id - b.id);
    // The emergency move rides in the hand as a card because that is where the player is
    // already looking, and because it is spent the same way a card is.
    if (hand.emergency) {
      slots.push({ id: EMERGENCY_CARD_ID, kind: 'wild', playable: true, emergency: true });
    }
    return slots;
  }

  private reconcileHand(hand: HandState | null, hadHand: boolean): void {
    const slots = this.slotsFor(hand);
    const wanted = new Set(slots.map(s => s.id));

    // gone: spent, discarded to a mulligan, or the turn taking the emergency card back
    for (const [id, el] of [...this.cardEls]) {
      if (wanted.has(id)) continue;
      this.cardEls.delete(id);
      el.classList.remove('card-on');
      el.classList.add('card-spent');
      el.setAttribute('aria-hidden', 'true');
      el.tabIndex = -1;
      this.later(() => el.remove(), EXIT_MS);
    }

    let dealt = 0;
    slots.forEach((slot, i) => {
      let el = this.cardEls.get(slot.id);
      if (!el) {
        el = this.buildCard(slot);
        this.cardEls.set(slot.id, el);
        this.handEl.appendChild(el);
        // The very first hand of a session arrives with the room already on screen, so it
        // deals in like any other draw -- there is no state to preserve by skipping it.
        el.style.setProperty('--deal-delay', `${dealt * DEAL_STAGGER_MS}ms`);
        el.classList.add('card-dealt');
        this.later(() => el!.classList.remove('card-dealt'),
          CardHand.DEAL_MS + dealt * DEAL_STAGGER_MS);
        dealt++;
      }
      el.style.order = String(i);
      this.paintCard(el, slot, hand);
    });

    if (dealt > 0 && hadHand) this.handlers.onDeal?.(dealt);
  }

  private buildCard(slot: Slot): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.dataset.id = String(slot.id);
    el.innerHTML = `
      <span class="card-pip"></span>
      <span class="card-art"></span>
      <span class="card-name"></span>
      <span class="card-sheen" aria-hidden="true"></span>`;

    el.addEventListener('click', () => {
      if (el.classList.contains('card-dead') || el.classList.contains('card-spent')) {
        el.classList.remove('card-nope');
        void el.offsetWidth;              // restart the refusal shake
        el.classList.add('card-nope');
        return;
      }
      this.selectedId = this.selectedId === slot.id ? null : slot.id;
      this.handlers.onSelect(this.selectedId);
      this.repaintSelection();
    });
    el.addEventListener('pointerenter', () => this.handlers.onHover(slot.id));
    el.addEventListener('pointerleave', () => this.handlers.onHover(null));
    el.addEventListener('focus', () => this.handlers.onHover(slot.id));
    el.addEventListener('blur', () => this.handlers.onHover(null));
    return el;
  }

  private paintCard(el: HTMLElement, slot: Slot, hand: HandState | null): void {
    const label = slot.emergency ? 'Emergency' : KIND_LABEL[slot.kind];
    // Dead cards are only marked dead on your own turn; against the opponent's position
    // "playable" would be measuring the wrong side's moves.
    const dead = hand?.yourTurn === true && !slot.playable;

    el.className = [
      'card', `card-${slot.emergency ? 'emergency' : slot.kind}`,
      dead ? 'card-dead' : '',
      this.selectedId === slot.id ? 'card-on' : '',
      el.classList.contains('card-dealt') ? 'card-dealt' : '',
    ].filter(Boolean).join(' ');

    el.querySelector('.card-pip')!.textContent =
      slot.emergency ? '!' : KIND_PIP[slot.kind];
    const art = el.querySelector('.card-art')!;
    const wantArt = slot.emergency ? 'em' : slot.kind;
    if (art.getAttribute('data-art') !== wantArt) {
      art.setAttribute('data-art', wantArt);
      art.innerHTML = slot.emergency
        ? '<span class="card-glyph">!</span>'
        : slot.kind === 'wild'
          ? '<span class="card-glyph">★</span>'
          : pieceSvg(`w${KIND_PIECE[slot.kind]}` as PieceCode);
    }
    el.querySelector('.card-name')!.textContent = label;

    el.setAttribute('aria-pressed', String(this.selectedId === slot.id));
    el.setAttribute('aria-disabled', String(dead));
    el.title = dead ? `${label} — no legal move with this card` : label;
    el.setAttribute('aria-label', slot.emergency
      ? 'Emergency move: move any piece, and discard one card at random'
      : dead ? `${label}, no legal move` : label);
  }

  /** Only the picked/unpicked pair changes, so nothing else is touched. */
  private repaintSelection(): void {
    for (const [id, el] of this.cardEls) {
      const on = id === this.selectedId;
      el.classList.toggle('card-on', on);
      el.setAttribute('aria-pressed', String(on));
    }
  }

  private renderActions(hand: HandState | null): void {
    const want = hand?.mulliganAvailable === true;
    const has = this.actionsEl.childElementCount > 0;
    if (want === has) return;
    if (!want) { this.actionsEl.innerHTML = ''; return; }
    this.actionsEl.innerHTML = `
      <button class="btn btn-sm card-mulligan" id="mull"
        title="Once a game: throw this hand away and draw a new one">Mulligan</button>`;
    this.actionsEl.querySelector('#mull')!
      .addEventListener('click', this.handlers.onMulligan);
  }

  destroy(): void {
    this.offMotion();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

/** "knights", "knights and rooks", "knights, rooks and queens". */
function listOf(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The face-up record of what a side has spent, newest last, oldest folded into a count. */
function spentStrip(played: CardKind[], color: Color): string {
  if (played.length === 0) return '<span class="spent-none">—</span>';
  const shown = played.slice(-12);
  const hidden = played.length - shown.length;
  const c = color === 'white' ? 'w' : 'b';
  const pips = shown.map((k, i) => (k === 'wild'
    ? `<span class="spent-pip spent-wild" style="--i:${i}" title="Wild">★</span>`
    : `<span class="spent-pip" style="--i:${i}" title="${KIND_LABEL[k]}">${
        pieceSvg(`${c}${KIND_PIECE[k]}` as PieceCode)}</span>`)).join('');
  return `${hidden > 0 ? `<span class="spent-more">+${hidden}</span>` : ''}${pips}`;
}

export { escapeHtml };
