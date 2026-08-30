import { pieceSvg, type PieceCode } from '../board/pieces';
import { escapeHtml } from './timerRing';
import { motionLevel, onMotionChange, type MotionLevel } from '../state/motion';
import type { CardKind, HandState, CardsPublic, CardSidePublic, Color } from '../types';

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
/**
 * The piece types a hand *holds* a card for, ignoring whether they can move right now.
 *
 * `reachOf` answers "what can I move this instant", which is only meaningful on your own
 * turn -- off turn every card is marked unplayable, so it returns nothing. A premove is
 * chosen off turn and asks the other question: could this hand pay for that piece at all.
 */
export function heldReach(hand: HandState | null): Set<string> {
  const out = new Set<string>(['k']);
  if (!hand) return out;
  if (hand.emergency) { for (const t of 'pnbrq') out.add(t); return out; }
  for (const c of hand.cards) {
    for (const t of typesForKind(c.kind)) out.add(t);
  }
  return out;
}

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
  /** The sacrifice was armed, disarmed, or its pile of cards changed. */
  onSacrificeChange?: (armed: boolean) => void;
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
   * The other side of the table: what the opponent holds, and what has been spent.
   *
   * A strip above the board rather than a panel in a side column. It was the latter, and
   * the report that changed it asked for the enemy's cards to be above the table where
   * they belong -- which is right, and costs the board nothing, because one line of card
   * backs is not the hundred pixels the panel was avoiding.
   */
  readonly infoEl: HTMLElement;
  private handEl: HTMLElement;
  private actionsEl: HTMLElement;
  private oppEl: HTMLElement;
  private noteEl: HTMLElement;
  private handlers: CardHandHandlers;
  private selectedId: number | null = null;
  /**
   * The sacrifice: on while the player is choosing which cards to burn, and the ids they
   * have chosen so far. Kept apart from `selectedId` on purpose -- one is "this card pays
   * for the move", the other is "these cards buy the right to ignore the cards", and
   * folding them into one selection would make the two impossible to tell apart.
   */
  private sacrificing = false;
  private sacrificeIds: number[] = [];
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

    this.infoEl = document.createElement('div');
    this.infoEl.className = 'opp-strip';
    this.infoEl.innerHTML = `<div class="cards-opp" id="opp"></div>`;
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

  /**
   * The cards a sacrifice would burn, once the full cost has been chosen; null until then.
   * A part-built pile is not a move that can be made yet, so it reads as nothing.
   */
  sacrificeSelection(): number[] | null {
    if (!this.sacrificing || !this.hand) return null;
    return this.sacrificeIds.length === this.hand.sacrificeCost
      ? [...this.sacrificeIds] : null;
  }

  /** True while the player is building a sacrifice, whether or not it is paid for yet. */
  sacrificeArmed(): boolean { return this.sacrificing; }

  /** Board reach for the current pick, or for the whole hand when nothing is picked. */
  reach(): Set<string> | null {
    if (!this.hand) return null;
    // A paid-up sacrifice opens the whole board, which is the entire thing it buys.
    if (this.sacrificeSelection()) return new Set(['k', 'p', 'n', 'b', 'r', 'q']);
    if (this.sacrificing) return new Set(['k']);
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
    const wasSacrificing = this.sacrificing;
    this.sacrificing = false;
    this.sacrificeIds = [];
    if (this.selectedId != null) {
      this.selectedId = null;
      this.handlers.onSelect(null);
    }
    this.repaintSelection();
    if (wasSacrificing) {
      this.renderActions(this.hand);
      this.renderNote(this.hand);
      this.handlers.onSacrificeChange?.(false);
    }
  }

  /** Start or abandon a sacrifice. Picking one drops the other; they are rival answers. */
  private toggleSacrifice(): void {
    if (!this.hand?.sacrificeAvailable && !this.sacrificing) return;
    this.sacrificing = !this.sacrificing;
    this.sacrificeIds = [];
    if (this.sacrificing && this.selectedId != null) {
      this.selectedId = null;
      this.handlers.onSelect(null);
    }
    this.repaintSelection();
    this.renderActions(this.hand);
    this.renderNote(this.hand);
    this.handlers.onSacrificeChange?.(this.sacrificing);
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

    // and neither can a half-built sacrifice: the cards it named may have been spent, and
    // the turn it was being built in may have passed
    if (this.sacrificing) {
      const live = new Set(hand?.cards.map(c => c.id) ?? []);
      this.sacrificeIds = this.sacrificeIds.filter(id => live.has(id));
      if (!hand?.yourTurn || !(hand.sacrificeAvailable || this.sacrificeIds.length > 0)) {
        this.sacrificing = false;
        this.sacrificeIds = [];
      }
    }

    this.el.classList.toggle('hand-live', hand?.yourTurn === true);
    this.infoEl.classList.toggle('hand-live', hand?.yourTurn === true);
    this.renderOpponent(cards, myColor);
    this.renderNote(hand);
    this.reconcileHand(hand, hadHand);
    this.renderActions(hand);
  }

  // ---- the opponent's side of the table ----

  /**
   * The other side of the table, as a strip above the board.
   *
   * It was a panel in the side column called "The table", and the report asked for the
   * enemy's card backs above the board instead and for the widget itself to go. That is
   * the better place for them: an opponent's hand is a thing you look at across a board,
   * not a paragraph in a sidebar, and putting it there costs a column that the roster and
   * the chat can use.
   *
   * Nothing is lost on the way. The backs carry the count, their spent pile keeps its
   * face-up record, and the four facts about the deck that were chips in the panel are
   * chips here -- smaller, on one line, and next to the only thing that makes them
   * meaningful.
   */
  private renderOpponent(cards: CardsPublic | null, myColor: Color | null): void {
    if (!cards) { this.oppEl.innerHTML = ''; return; }
    const me = myColor ? cards[myColor] : null;
    const oppColor: Color = myColor === 'white' ? 'black' : 'white';
    const opp = cards[oppColor];
    const name = (c: Color): string => (c === 'white' ? 'White' : 'Black');

    const backs = (side: CardSidePublic): string => Array.from(
      { length: side.handCount },
      (_, i) => `<span class="card-back" style="--i:${i}"></span>`).join('');

    const hand = (color: Color, side: CardSidePublic): string => `
      <span class="opp-who">${name(color)}</span>
      <span class="opp-backs">${backs(side)
        || '<span class="opp-none">no cards</span>'}</span>
      <span class="opp-count">${side.handCount}</span>`;

    // A spectator holds no hand of their own, so they are shown both.
    const hands = me
      ? hand(oppColor, opp)
      : `${hand('white', cards.white)}<span class="opp-split"></span>${
        hand('black', cards.black)}`;

    const spentOf = (side: CardSidePublic, color: Color): string =>
      (side.played.length === 0 ? '' : `<span class="opp-spent"
        title="${name(color)} has spent ${side.played.length} card(s)">
        ${spentStrip(side.played, color)}</span>`);

    this.oppEl.innerHTML = `
      <div class="opp-hand">${hands}${spentOf(opp, oppColor)}</div>
      <div class="opp-facts">
        <span title="Cards still to be dealt from ${me ? 'your' : 'that'} draw pile">
          <b>${me ? me.deckCount : opp.deckCount}</b> in deck</span>
        <span title="Dealt at the start of every turn, up to the hand cap">
          <b>${cards.drawPerTurn}</b> a turn</span>
        ${capMeta(cards, me)}
        ${sacrificeMeta(cards, me)}
        ${cards.enraged
          ? '<span class="meta-hot" title="Twenty plies in, both sides deal one more">enraged</span>'
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
    if (this.sacrificing) {
      const left = hand.sacrificeCost - this.sacrificeIds.length;
      set('note-sacrifice', left > 0
        ? `Choose ${left} more card${left > 1 ? 's' : ''} to burn — then move any piece.`
        : 'Paid. Move any piece you like; these cards are gone.');
      return;
    }
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
    // Cycling is the quieter cousin of the swap: the hand could not move anything at all,
    // so the dead cards were dealt past. Same reasoning -- a rule the player cannot see
    // happening has to say so on the turn it happens.
    if (hand.cycled.length > 0) {
      const kinds = [...new Set(hand.cycled)].map(k => KIND_PLURAL[k]);
      set('note-swap', `Nothing in hand could move — dealt past `
        + `${hand.cycled.length > 1 ? 'those cards' : 'that card'} (${listOf(kinds)}).`);
      return;
    }
    // A castle you cannot pay for is a rule the board is silently enforcing, so it says
    // why rather than leaving the player to wonder what happened to their king.
    if (!hand.canCastle) {
      set('note-live', 'Play a card, or just move. No Rook card, so castling is out — '
        + 'the rook travels too, and it has to be paid for.');
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
      // Position in the fan, and how wide a fan it is. Written as custom properties
      // because the angle and the lift are the stylesheet's business, not this file's --
      // all it knows is that this is card `i` of `n`.
      el.style.order = String(i);
      el.style.setProperty('--i', String(i));
      this.paintCard(el, slot, hand);
    });
    this.handEl.style.setProperty('--n', String(slots.length));

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

    const refuse = (): void => {
      el.classList.remove('card-nope');
      void el.offsetWidth;                // restart the refusal shake
      el.classList.add('card-nope');
    };

    el.addEventListener('click', () => {
      if (el.classList.contains('card-spent')) return;

      // While a sacrifice is being built every card is fuel, dead ones included -- that is
      // rather the point of it, and refusing a dead card here would be refusing the only
      // cards a stuck player has to pay with.
      if (this.sacrificing) {
        if (slot.emergency) { refuse(); return; }
        const at = this.sacrificeIds.indexOf(slot.id);
        if (at >= 0) this.sacrificeIds.splice(at, 1);
        else if (this.sacrificeIds.length < (this.hand?.sacrificeCost ?? 0)) {
          this.sacrificeIds.push(slot.id);
        } else { refuse(); return; }
        this.repaintSelection();
        this.renderActions(this.hand);
        this.renderNote(this.hand);
        this.handlers.onSacrificeChange?.(true);
        return;
      }

      if (el.classList.contains('card-dead')) { refuse(); return; }
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
      this.sacrificeIds.includes(slot.id) ? 'card-burn' : '',
      this.sacrificing && slot.emergency ? 'card-dead' : '',
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
      const burning = this.sacrificeIds.includes(id);
      el.classList.toggle('card-on', on);
      el.classList.toggle('card-burn', burning);
      el.setAttribute('aria-pressed', String(on || burning));
    }
  }

  /**
   * Mulligan and sacrifice, the two ways out of a hand you cannot use.
   *
   * Rebuilt whenever either could have changed rather than diffed, because the sacrifice
   * button's own label is state -- it counts down the cards still to choose -- and a
   * cheap innerHTML swap of two buttons is not worth the bookkeeping to avoid.
   */
  private renderActions(hand: HandState | null): void {
    const parts: string[] = [];

    if (hand?.mulliganAvailable === true && !this.sacrificing) {
      parts.push(`<button class="btn card-action card-mulligan" id="mull"
        title="Once a game: throw this hand away and take a fresh opening hand">
        ${RECYCLE}<span>Mulligan</span></button>`);
    }

    if (hand?.yourTurn) {
      if (this.sacrificing) {
        const left = hand.sacrificeCost - this.sacrificeIds.length;
        parts.push(`<button class="btn card-action card-sacrifice on" id="sac">
          ${SKULL}<span>${left > 0 ? `Burn ${left} more` : 'Move any piece'}</span></button>`);
        parts.push(`<button class="btn card-action btn-ghost" id="sacoff">
          <span>Cancel</span></button>`);
      } else if (hand.sacrificeAvailable) {
        parts.push(`<button class="btn card-action card-sacrifice" id="sac"
          title="Burn ${hand.sacrificeCost} cards to move any piece you like">
          ${SKULL}<span>Sacrifice ${hand.sacrificeCost}</span></button>`);
      } else if (hand.sacrificeReadyIn > 0) {
        parts.push(`<span class="card-action card-sacrifice-wait"
          title="The sacrifice comes back once enough of the game has passed">
          ${SKULL}<span>Sacrifice in ${hand.sacrificeReadyIn}</span></span>`);
      }
    }

    const html = parts.join('');
    if (this.actionsEl.innerHTML === html) return;
    this.actionsEl.innerHTML = html;
    this.actionsEl.querySelector('#mull')
      ?.addEventListener('click', this.handlers.onMulligan);
    this.actionsEl.querySelector('#sac')
      ?.addEventListener('click', () => this.toggleSacrifice());
    this.actionsEl.querySelector('#sacoff')
      ?.addEventListener('click', () => this.toggleSacrifice());
  }

  destroy(): void {
    this.offMotion();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

/**
 * The hand cap, and whether it has started to close in.
 *
 * It falls with the army -- a card is only worth holding while you still own a piece it
 * names -- so below the maximum it is news rather than a constant, and says so.
 */
function capMeta(cards: CardsPublic, me: CardSidePublic | null): string {
  const cap = me ? me.handCap : cards.handMax;
  const shrunk = cap < cards.handMax;
  return `<span class="${shrunk ? 'meta-shrunk' : ''}" title="${shrunk
    ? 'Fewer piece kinds left on the board means fewer cards worth holding. '
      + 'Nothing is taken from you: the deal stops until your hand is back under the cap.'
    : 'A hand never grows past this; the deal simply stops'}"><b>${cap}</b> cards in hand`
    + `${shrunk ? ' (shrinking with your army)' : ' at most'}</span>`;
}

/**
 * How the sacrifice reads on the shared table: its price, or the wait still to serve.
 *
 * A spectator holds no side, so there is no cooldown that is theirs to be told about --
 * they get the price alone rather than one player'''s countdown labelled as if it were
 * everyone'''s.
 */
function sacrificeMeta(cards: CardsPublic, me: CardSidePublic | null): string {
  if (me && me.sacrificeReadyIn > 0) {
    return `<span title="Plies until you may sacrifice again">`
      + `sacrifice ready in <b>${me.sacrificeReadyIn}</b></span>`;
  }
  return `<span title="Burn ${cards.sacrificeCost} cards to move any piece you like">`
    + `sacrifice costs <b>${cards.sacrificeCost}</b> cards</span>`;
}

/*
 * The two icons on the hand's buttons.
 *
 * Drawn here rather than pulled from a set: two glyphs are not worth a dependency, and
 * both want to be exactly what they are -- a skull for the sacrifice, because burning
 * three cards to move one piece is a death in the hand, and a loop for the mulligan,
 * because the cards go back and come round again. Single paths in `currentColor`, so
 * each takes the colour of the button it sits in and needs no second set for the
 * armed state.
 */
const SKULL = `<svg class="ca-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path fill="currentColor" fill-rule="evenodd" d="M8 1.1c-3.3 0-5.9 2.5-5.9 5.5 0 1.8.9
    3.4 2.3 4.4.3.2.4.5.4.8v1.1c0 .6.5 1.1 1.1 1.1h.6v-1.4c0-.3.2-.5.5-.5s.5.2.5.5V14h1v-1.4c0
    -.3.2-.5.5-.5s.5.2.5.5V14h.6c.6 0 1.1-.5 1.1-1.1v-1.1c0-.3.1-.6.4-.8 1.4-1 2.3-2.6
    2.3-4.4 0-3-2.6-5.5-5.9-5.5Zm-2.6 4.6a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2Zm5.2 0a1.6
    1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2ZM8 9.6c.3 0 .6.3.6.6v.3H7.4v-.3c0-.3.3-.6.6-.6Z"/>
</svg>`;

const RECYCLE = `<svg class="ca-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path fill="currentColor" d="M8 2.6c1.5 0 2.9.7 3.8 1.8l1-1V7H9.5l1.2-1.2A3.7 3.7 0 0 0
    4.4 7.4a.85.85 0 1 1-1.66-.33A5.4 5.4 0 0 1 8 2.6Zm5.26 6a.85.85 0 0 1 .66 1
    5.4 5.4 0 0 1-9 2.8l-1 1V9.7h3.3L6 10.9a3.7 3.7 0 0 0 6.26-1.6.85.85 0 0 1 1-.7Z"/>
</svg>`;

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
