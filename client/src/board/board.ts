import { Chess } from 'chess.js';
import { pieceSvg, type PieceCode } from './pieces';
import type { Orientation } from '../state/store';
import type { MarkView } from '../types';

export interface BoardCallbacks {
  /** Return true if the move was accepted, so the board knows whether to snap back. */
  onMove: (from: string, to: string, promotion?: string) => Promise<boolean>;
  onIllegal: () => void;
  onPickup: () => void;
  /** Ask the UI for a promotion piece; resolve null to cancel the move. */
  requestPromotion: (color: 'w' | 'b') => Promise<string | null>;
  /** Flag a square for your team (right-click, or X on the keyboard). */
  onMark?: (square: string) => void;
  /**
   * A move chosen before it is this player's turn, or null when one is dropped.
   *
   * The board only reports it; whether it can be afforded and when it is played are
   * decisions for the room, which is the thing that knows about cards and turns.
   */
  onPremove?: (move: { from: string; to: string } | null) => void;
}

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

const PIECE_NAMES: Record<string, string> = {
  p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king',
};

/** How a square is read aloud: "e4, white pawn", or "e4, empty". */
function describe(square: string, code: PieceCode | null): string {
  if (!code) return `${square}, empty`;
  const color = code[0] === 'w' ? 'white' : 'black';
  return `${square}, ${color} ${PIECE_NAMES[code[1]] ?? 'piece'}`;
}

interface PieceEl {
  el: HTMLElement;
  code: PieceCode;
  square: string;
}

export class Board {
  private root: HTMLElement;
  private squaresLayer!: HTMLElement;
  private markerLayer!: HTMLElement;
  private pieceLayer!: HTMLElement;
  private cb: BoardCallbacks;

  private chess = new Chess();
  private pieces = new Map<string, PieceEl>();   // square -> piece
  private orient: Orientation = 'white';
  private interactive = false;
  private myColor: 'w' | 'b' | null = null;
  /**
   * Cards mode: the piece types this player may move right now. Null means no restriction,
   * which is every board in the team game.
   */
  private allowedTypes: Set<string> | null = null;
  /**
   * Whether castling may be offered.
   *
   * Castling is a king move, so `allowedTypes` waves it through -- but in Chess Cards the
   * rook travels too and it costs a Rook card. Without this the board would light up the
   * castling square and the server would refuse the move when it got there, which reads
   * as a bug rather than as a rule.
   */
  private castleOk = true;

  /**
   * Premoves: choosing your reply while the opponent is still thinking.
   *
   * `premoveOn` is whether the board should accept one at all -- it is your seat, the
   * game is live, and (in cards mode) your hand could pay for the piece. `premove` is the
   * one currently queued, drawn on the board so it is never a secret what will happen the
   * instant your turn opens.
   */
  private premoveOn = false;
  private premove: { from: string; to: string } | null = null;
  private premoveTargets = new Set<string>();
  private premoveFrom: string | null = null;

  private selected: string | null = null;
  private legalTargets = new Set<string>();
  private dragging: {
    piece: PieceEl; originSquare: string; pointerId: number;
    offsetX: number; offsetY: number; moved: boolean;
  } | null = null;

  private lastMove: { from: string; to: string } | null = null;
  private checkSquare: string | null = null;
  private marks: MarkView[] = [];

  private squareEls: HTMLElement[] = [];    // visual order, row-major
  private live!: HTMLElement;
  /** Keyboard cursor. Drawn only once the board has actually been driven by keyboard, so
      a mouse player never sees a focus ring they did not ask for. */
  private cursor: string | null = null;
  private kbActive = false;

  constructor(root: HTMLElement, cb: BoardCallbacks) {
    this.root = root;
    this.cb = cb;
    this.build();
  }

  private build(): void {
    this.root.classList.add('board');
    this.root.innerHTML = `
      <div class="board-frame">
        <div class="board-squares" role="grid" tabindex="0" aria-label="Chess board.
             Arrow keys move the cursor, Enter selects and moves, X marks a square for
             your team."></div>
        <div class="board-markers" aria-hidden="true"></div>
        <div class="board-pieces" aria-hidden="true"></div>
      </div>
      <div class="sr-only" role="status" aria-live="polite"></div>`;
    this.squaresLayer = this.root.querySelector('.board-squares')!;
    this.markerLayer = this.root.querySelector('.board-markers')!;
    this.pieceLayer = this.root.querySelector('.board-pieces')!;
    this.live = this.root.querySelector('.sr-only')!;

    // Rows exist for assistive technology, not for layout: `display: contents` keeps the
    // eight-by-eight CSS grid intact while giving the grid role the rows it requires.
    for (let r = 0; r < 8; r++) {
      const row = document.createElement('div');
      row.setAttribute('role', 'row');
      row.style.display = 'contents';
      for (let c = 0; c < 8; c++) {
        const sq = document.createElement('div');
        sq.className = 'sq';
        sq.setAttribute('role', 'gridcell');
        row.appendChild(sq);
        this.squareEls.push(sq);
      }
      this.squaresLayer.appendChild(row);
    }
    this.paintSquares();

    this.root.addEventListener('pointerdown', this.onPointerDown);
    this.root.addEventListener('contextmenu', this.onContextMenu);
    this.squaresLayer.addEventListener('keydown', this.onKeyDown);
    this.squaresLayer.addEventListener('focus', this.onFocus);
    this.squaresLayer.addEventListener('blur', this.onBlur);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  }

  /** Speak something to screen readers. Identical text is not re-announced, so nudge it. */
  private say(msg: string): void {
    this.live.textContent = this.live.textContent === msg ? msg + ' ' : msg;
  }

  // ---- coordinate helpers ----

  /** Visual row/col for a square, honouring orientation. */
  private rc(square: string): { r: number; c: number } {
    const file = FILES.indexOf(square[0]);
    const rank = Number(square[1]) - 1;
    return this.orient === 'white'
      ? { r: 7 - rank, c: file }
      : { r: rank, c: 7 - file };
  }

  private squareAt(r: number, c: number): string {
    return this.orient === 'white'
      ? `${FILES[c]}${8 - r}`
      : `${FILES[7 - c]}${r + 1}`;
  }

  private squareFromPoint(clientX: number, clientY: number): string | null {
    const rect = this.squaresLayer.getBoundingClientRect();
    const size = rect.width / 8;
    const c = Math.floor((clientX - rect.left) / size);
    const r = Math.floor((clientY - rect.top) / size);
    if (r < 0 || r > 7 || c < 0 || c > 7) return null;
    return this.squareAt(r, c);
  }

  private place(el: HTMLElement, square: string): void {
    const { r, c } = this.rc(square);
    el.style.transform = `translate(${c * 100}%, ${r * 100}%)`;
  }

  private paintSquares(): void {
    const kids = this.squareEls;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const el = kids[r * 8 + c];
        const sq = this.squareAt(r, c);
        const dark = (FILES.indexOf(sq[0]) + Number(sq[1])) % 2 === 0;
        el.className = `sq ${dark ? 'sq-dark' : 'sq-light'}`;
        el.dataset.square = sq;
        el.id = `bl-sq-${sq}`;
        el.textContent = '';
        // rank/file labels on the outer edges only
        if (c === 0) {
          const t = document.createElement('span');
          t.className = 'coord coord-rank';
          t.textContent = sq[1];
          el.appendChild(t);
        }
        if (r === 7) {
          const t = document.createElement('span');
          t.className = 'coord coord-file';
          t.textContent = sq[0];
          el.appendChild(t);
        }
      }
    }
    this.labelSquares();
  }

  /**
   * Keep every square's spoken label in step with the position. This is the whole of the
   * screen-reader story: the piece layer is aria-hidden, so the grid of labelled cells is
   * what a reader actually walks.
   */
  private labelSquares(): void {
    for (const el of this.squareEls) {
      const sq = el.dataset.square!;
      const p = this.pieces.get(sq);
      let label = describe(sq, p ? p.code : null);
      if (this.checkSquare === sq) label += ', in check';
      if (this.lastMove && (this.lastMove.from === sq || this.lastMove.to === sq)) {
        label += ', last move';
      }
      if (this.marks.some(m => m.square === sq)) label += ', marked by your team';
      if (this.legalTargets.has(sq)) label += ', legal move';
      el.setAttribute('aria-label', label);
      el.setAttribute('aria-selected', String(this.selected === sq));
    }
  }

  // ---- public API ----

  setOrientation(o: Orientation): void {
    if (o === this.orient) return;
    this.orient = o;
    this.paintSquares();
    for (const p of this.pieces.values()) {
      p.el.classList.add('no-anim');
      this.place(p.el, p.square);
    }
    // let the layout settle before re-enabling transitions
    requestAnimationFrame(() => requestAnimationFrame(() => {
      for (const p of this.pieces.values()) p.el.classList.remove('no-anim');
    }));
    this.renderMarkers();
  }

  setInteractive(on: boolean, myColor: 'w' | 'b' | null): void {
    const was = this.interactive;
    this.interactive = on;
    this.myColor = myColor;
    this.root.classList.toggle('board-live', on);
    if (!on) { this.clearSelection(); this.renderMarkers(); }
    if (on && !was && this.kbActive) this.say('Your move. The board is yours.');
  }

  /** The queued move, for the room to play the moment the turn opens. */
  pendingPremove(): { from: string; to: string } | null {
    return this.premove;
  }

  /**
   * Narrow which of your own pieces can be picked up, by piece type.
   *
   * This is how a card reaches the board: hold only a Knight and the knights are the only
   * thing that lifts. Passing null removes the restriction. The pieces you cannot move are
   * dimmed rather than hidden -- they are still yours, and reading the whole position is
   * most of the game.
   */
  setAllowedTypes(types: Set<string> | null): void {
    const same = types === this.allowedTypes
      || (types != null && this.allowedTypes != null
          && types.size === this.allowedTypes.size
          && [...types].every(x => this.allowedTypes!.has(x)));
    if (same) return;
    this.allowedTypes = types;
    if (this.selected && !this.canMove(this.selected)) this.clearSelection();
    this.paintReach();
    this.renderMarkers();
  }

  /** Whether a move may be queued for the turn that has not arrived yet. */
  setPremoveEnabled(on: boolean): void {
    if (this.premoveOn === on) return;
    this.premoveOn = on;
    if (!on) this.clearPremove();
  }

  /** Drop the queued move, and tell the room so its own copy goes with it. */
  clearPremove(announce = true): void {
    const had = this.premove != null || this.premoveFrom != null;
    this.premove = null;
    this.premoveFrom = null;
    this.premoveTargets.clear();
    if (had) {
      this.renderMarkers();
      if (announce) this.cb.onPremove?.(null);
    }
  }

  /**
   * Where a piece could go if it were this player's turn.
   *
   * chess.js only generates moves for the side to move, so the position is reloaded with
   * the turn flipped. That can be an illegal position -- the opponent has just given
   * check, say -- in which case there is nothing sensible to offer and premoves are
   * simply not available for that turn.
   */
  private premoveTargetsFor(square: string): Set<string> {
    const out = new Set<string>();
    if (!this.myColor) return out;
    const parts = this.chess.fen().split(' ');
    if (parts[1] === this.myColor) {
      // already our turn by the FEN; the ordinary path handles that
      return out;
    }
    parts[1] = this.myColor;
    parts[3] = '-';        // an en-passant square belongs to the other side's last move
    try {
      const probe = new Chess(parts.join(' '));
      const moves = probe.moves({ square: square as never, verbose: true }) as unknown as
        Array<{ to: string; flags: string }>;
      for (const m of moves) {
        if (!this.castleOk && (m.flags.includes('k') || m.flags.includes('q'))) continue;
        out.add(m.to);
      }
    } catch { /* the flipped position is not legal; offer nothing */ }
    return out;
  }

  /** Click-to-queue while it is not your turn. Returns true when the click was used. */
  private handlePremoveClick(square: string): boolean {
    if (!this.premoveOn || this.interactive || !this.myColor) return false;

    if (this.premoveFrom && this.premoveTargets.has(square)) {
      this.premove = { from: this.premoveFrom, to: square };
      this.premoveFrom = null;
      this.premoveTargets.clear();
      this.renderMarkers();
      this.cb.onPremove?.(this.premove);
      return true;
    }

    const piece = this.pieces.get(square);
    if (piece && piece.code[0] === this.myColor) {
      // a fresh pick replaces whatever was queued: two queued moves is not a thing
      this.premove = null;
      this.premoveFrom = square;
      this.premoveTargets = this.premoveTargetsFor(square);
      this.renderMarkers();
      this.cb.onPremove?.(null);
      return true;
    }

    this.clearPremove();
    return true;
  }

  /** Cards mode: whether the hand can pay the Rook card a castle costs. */
  setCastlingAllowed(on: boolean): void {
    if (this.castleOk === on) return;
    this.castleOk = on;
    if (this.selected) {
      const was = this.selected;
      this.clearSelection();
      this.selectSquare(was);
    }
  }

  /**
   * How much of what is legal this hand can actually pay for.
   *
   * The same shape as the server's own choice set -- castles included only when the hand
   * can pay the Rook card they cost -- so the line the room prints agrees with the number
   * the archive records for that ply. Two counts of the same thing that disagree would be
   * worse than not showing one.
   */
  countAffordable(): { legal: number; affordable: number } {
    const moves = this.chess.moves({ verbose: true }) as unknown as
      Array<{ piece: string; flags: string }>;
    if (this.allowedTypes == null) return { legal: moves.length, affordable: moves.length };
    const allowed = this.allowedTypes;
    const castles = (m: { flags: string }): boolean =>
      m.flags.includes('k') || m.flags.includes('q');
    return {
      legal: moves.length,
      affordable: moves.filter(m => allowed.has(m.piece) && (this.castleOk || !castles(m)))
        .length,
    };
  }

  /** Whether the piece on a square is one this player may move at this moment. */
  private canMove(square: string): boolean {
    const piece = this.pieces.get(square);
    if (!piece) return false;
    if (this.myColor && piece.code[0] !== this.myColor) return false;
    return this.allowedTypes == null || this.allowedTypes.has(piece.code[1]);
  }

  /** Dim your own pieces that the current card cannot reach. */
  private paintReach(): void {
    const restricted = this.allowedTypes != null && this.interactive;
    for (const [, p] of this.pieces) {
      const mine = !this.myColor || p.code[0] === this.myColor;
      const reachable = !restricted || !mine || this.allowedTypes!.has(p.code[1]);
      p.el.classList.toggle('pc-out-of-reach', !reachable && mine);
    }
  }

  /**
   * Squares your teammates have flagged. Returns what changed so the caller can decide
   * whether to make a noise about it -- the marks are re-pushed on every state broadcast,
   * and re-announcing an unchanged set would be unbearable.
   */
  setMarks(marks: MarkView[]): { added: MarkView[]; changed: boolean } {
    const key = (m: MarkView): string => `${m.square}:${m.name}`;
    const before = new Set(this.marks.map(key));
    const added = marks.filter(m => !before.has(key(m)));
    const changed = added.length > 0 || marks.length !== this.marks.length;
    this.marks = marks;
    if (changed) {
      this.renderMarkers();
      // one sentence, not one per mark: consecutive writes to a live region overwrite
      // each other, so a loop would announce only whichever happened to be last
      if (added.length > 0) {
        this.say(added
          .map(m => (m.own ? `You marked ${m.square}` : `${m.name} marked ${m.square}`))
          .join('. '));
      }
    }
    return { added, changed };
  }

  /**
   * Reconcile the board to a FEN. Pieces that merely moved are transformed to their new
   * square so CSS animates the slide; only genuinely new or removed pieces touch the DOM.
   */
  setPosition(fen: string, lastMove: { from: string; to: string } | null, inCheck: boolean): void {
    this.chess.load(fen);
    this.lastMove = lastMove;

    const target = new Map<string, PieceCode>();
    for (const row of this.chess.board()) {
      for (const cell of row) {
        if (cell) target.set(cell.square, `${cell.color}${cell.type}` as PieceCode);
      }
    }

    // 1. a piece that vanished from its square, where an identical piece appeared on a
    //    square that is now occupied, is the same piece having moved -- animate it.
    const survivors = new Map<string, PieceEl>();
    const unmatched: string[] = [];
    for (const [sq, p] of this.pieces) {
      if (target.get(sq) === p.code) { survivors.set(sq, p); target.delete(sq); }
      else unmatched.push(sq);
    }

    const moving: PieceEl[] = [];
    for (const sq of unmatched) {
      const p = this.pieces.get(sq)!;
      let dest: string | null = null;
      for (const [tsq, tcode] of target) {
        if (tcode === p.code) { dest = tsq; break; }
      }
      if (dest) {
        target.delete(dest);
        p.square = dest;
        moving.push(p);
        survivors.set(dest, p);
      } else {
        p.el.classList.add('pc-captured');
        const el = p.el;
        setTimeout(() => el.remove(), 180);
      }
    }

    for (const [sq, code] of target) {
      const p = this.spawn(code, sq);
      survivors.set(sq, p);
    }

    this.pieces = survivors;
    for (const p of moving) this.place(p.el, p.square);

    this.checkSquare = null;
    if (inCheck) {
      const turn = this.chess.turn();
      for (const [sq, p] of this.pieces) {
        if (p.code === `${turn}k`) { this.checkSquare = sq; break; }
      }
    }

    this.clearSelection();
    this.paintReach();
    this.renderMarkers();
  }

  private spawn(code: PieceCode, square: string): PieceEl {
    const el = document.createElement('div');
    el.className = 'pc pc-enter no-anim';
    el.innerHTML = pieceSvg(code);
    el.dataset.square = square;
    this.place(el, square);
    this.pieceLayer.appendChild(el);
    requestAnimationFrame(() => el.classList.remove('no-anim', 'pc-enter'));
    return { el, code, square };
  }

  // ---- markers ----

  private renderMarkers(): void {
    this.markerLayer.innerHTML = '';
    const add = (square: string, cls: string, delay = 0, html = ''): HTMLElement => {
      const m = document.createElement('div');
      m.className = `mk ${cls}`;
      if (delay) m.style.animationDelay = `${delay}ms`;
      if (html) m.innerHTML = html;
      this.place(m, square);
      this.markerLayer.appendChild(m);
      return m;
    };

    if (this.premove) {
      add(this.premove.from, 'mk-pre');
      add(this.premove.to, 'mk-pre mk-pre-to');
    }
    if (this.premoveFrom) {
      add(this.premoveFrom, 'mk-pre');
      let i = 0;
      for (const t of this.premoveTargets) {
        add(t, this.pieces.has(t) ? 'mk-pre-capture' : 'mk-pre-move', i++ * 10);
      }
    }

    if (this.lastMove) {
      add(this.lastMove.from, 'mk-last');
      add(this.lastMove.to, 'mk-last');
    }

    // Teammates' suggestions, drawn under the move markers and in a cool colour so they
    // never read as something the rules produced.
    const bySquare = new Map<string, MarkView[]>();
    for (const m of this.marks) {
      const list = bySquare.get(m.square);
      if (list) list.push(m); else bySquare.set(m.square, [m]);
    }
    for (const [square, list] of bySquare) {
      const own = list.some(m => m.own);
      const who = list.map(m => m.name).join(', ');
      const initials = list.map(m => (m.name[0] ?? '?').toUpperCase()).join('');
      const el = add(square, `mk-ghost ${own ? 'mk-ghost-own' : ''}`, 0,
        `<span class="mk-ghost-tag">${initials.slice(0, 3)}</span>`);
      el.title = `Marked by ${who}`;
    }

    if (this.checkSquare) add(this.checkSquare, 'mk-check');
    if (this.selected) add(this.selected, 'mk-selected');

    let i = 0;
    for (const t of this.legalTargets) {
      const occupied = this.pieces.has(t);
      add(t, occupied ? 'mk-capture' : 'mk-move', i * 14);
      i++;
    }

    if (this.kbActive && this.cursor) add(this.cursor, 'mk-cursor');
    this.labelSquares();
  }

  private selectSquare(square: string): void {
    const piece = this.pieces.get(square);
    if (!piece || !this.interactive) return;
    if (!this.canMove(square)) return;
    this.selected = square;
    this.legalTargets.clear();
    const moves = this.chess.moves({ square: square as never, verbose: true }) as unknown as
      Array<{ to: string; flags: string }>;
    for (const m of moves) {
      if (!this.castleOk && (m.flags.includes('k') || m.flags.includes('q'))) continue;
      this.legalTargets.add(m.to);
    }
    this.renderMarkers();
  }

  private clearSelection(): void {
    this.selected = null;
    this.legalTargets.clear();
  }

  // ---- keyboard play ----

  /**
   * Where the cursor starts: the square the last move landed on, so a keyboard player
   * arrives at the part of the board that just changed rather than at a fixed corner.
   */
  private ensureCursor(): string {
    if (!this.cursor) {
      this.cursor = this.lastMove?.to ?? (this.myColor === 'b' ? 'e7' : 'e2');
    }
    return this.cursor;
  }

  private setCursor(square: string, speak = true): void {
    this.cursor = square;
    this.kbActive = true;
    this.squaresLayer.setAttribute('aria-activedescendant', `bl-sq-${square}`);
    this.renderMarkers();
    if (speak) {
      const p = this.pieces.get(square);
      let msg = describe(square, p ? p.code : null);
      if (this.legalTargets.has(square)) msg += p ? ', capture available' : ', legal move';
      if (this.marks.some(m => m.square === square)) msg += ', marked';
      this.say(msg);
    }
  }

  private moveCursor(dr: number, dc: number): void {
    const { r, c } = this.rc(this.ensureCursor());
    const nr = Math.min(7, Math.max(0, r + dr));
    const nc = Math.min(7, Math.max(0, c + dc));
    this.setCursor(this.squareAt(nr, nc));
  }

  /** Enter/Space: pick up, put down, or complete a move -- whichever the state implies. */
  private activateCursor(): void {
    const square = this.ensureCursor();
    if (!this.interactive) {
      this.say('Not your turn. You can still move the cursor and mark squares.');
      return;
    }

    if (this.selected && this.legalTargets.has(square)) {
      const from = this.selected;
      this.say(`${from} to ${square}`);
      this.clearSelection();
      this.renderMarkers();
      void this.commit(from, square);
      return;
    }

    if (this.selected === square) {
      this.clearSelection();
      this.renderMarkers();
      this.say('Selection cleared');
      return;
    }

    const piece = this.pieces.get(square);
    if (!piece || (this.myColor && piece.code[0] !== this.myColor)) {
      this.say(piece ? 'That is not your piece' : 'No piece there');
      return;
    }
    if (!this.canMove(square)) {
      this.say(`${describe(square, piece.code)}. You hold no card for that piece.`);
      return;
    }

    this.selectSquare(square);
    this.cb.onPickup();
    const targets = Array.from(this.legalTargets);
    this.say(targets.length === 0
      ? `${describe(square, piece.code)}, no legal moves`
      : `Selected ${describe(square, piece.code)}. ${targets.length} moves: ${targets.join(', ')}`);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const step: Record<string, [number, number]> = {
      ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
    };
    const d = step[e.key];
    if (d) { e.preventDefault(); this.moveCursor(d[0], d[1]); return; }

    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const { r } = this.rc(this.ensureCursor());
      this.setCursor(this.squareAt(r, e.key === 'Home' ? 0 : 7));
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.kbActive = true;
      this.activateCursor();
      return;
    }
    if (e.key === 'Escape') {
      if (!this.selected) return;
      e.preventDefault();
      this.clearSelection();
      this.renderMarkers();
      this.say('Selection cleared');
      return;
    }
    if (e.key === 'x' || e.key === 'X') {
      e.preventDefault();
      e.stopPropagation();
      this.kbActive = true;
      this.cb.onMark?.(this.ensureCursor());
    }
  };

  /**
   * Reaching the board by Tab must show the cursor, or focus would be invisible. Reaching
   * it by clicking a piece must not, so :focus-visible decides -- the same rule the
   * browser uses for its own focus rings.
   */
  private onFocus = (): void => {
    if (!this.squaresLayer.matches(':focus-visible')) return;
    this.setCursor(this.ensureCursor());
  };

  private onBlur = (): void => {
    this.kbActive = false;
    this.renderMarkers();
  };

  // ---- interaction ----

  /** Right-click flags a square for your team; it never opens the browser menu here. */
  private onContextMenu = (e: MouseEvent): void => {
    const square = this.squareFromPoint(e.clientX, e.clientY);
    if (!square) return;
    e.preventDefault();
    this.cb.onMark?.(square);
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const square = this.squareFromPoint(e.clientX, e.clientY);
    if (!square) return;

    // Not our turn: the click either queues a move for when it is, or does nothing.
    if (!this.interactive) {
      if (this.handlePremoveClick(square)) e.preventDefault();
      return;
    }

    // Our turn now, so anything queued has been consumed or overtaken.
    this.clearPremove(false);

    // second click on a legal target completes a click-to-move
    if (this.selected && this.legalTargets.has(square)) {
      const from = this.selected;
      this.clearSelection();
      this.renderMarkers();
      void this.commit(from, square);
      return;
    }

    const piece = this.pieces.get(square);
    if (!piece || !this.canMove(square)) {
      if (piece && this.myColor && piece.code[0] === this.myColor) this.cb.onIllegal();
      this.clearSelection();
      this.renderMarkers();
      return;
    }

    this.selectSquare(square);
    this.cb.onPickup();
    this.cursor = square;

    const rect = piece.el.getBoundingClientRect();
    this.dragging = {
      piece,
      originSquare: square,
      pointerId: e.pointerId,
      offsetX: e.clientX - rect.left - rect.width / 2,
      offsetY: e.clientY - rect.top - rect.height / 2,
      moved: false,
    };
    piece.el.classList.add('pc-drag');
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const d = this.dragging;
    if (!d || e.pointerId !== d.pointerId) return;
    d.moved = true;
    const rect = this.squaresLayer.getBoundingClientRect();
    const size = rect.width / 8;
    const x = e.clientX - rect.left - d.offsetX - size / 2;
    const y = e.clientY - rect.top - d.offsetY - size / 2;
    d.piece.el.style.transform = `translate(${(x / size) * 100}%, ${(y / size) * 100}%)`;

    const over = this.squareFromPoint(e.clientX, e.clientY);
    this.markerLayer.querySelectorAll('.mk-hover').forEach(n => n.classList.remove('mk-hover'));
    if (over && this.legalTargets.has(over)) {
      for (const mk of Array.from(this.markerLayer.children) as HTMLElement[]) {
        const { r, c } = this.rc(over);
        if (mk.style.transform === `translate(${c * 100}%, ${r * 100}%)`) {
          mk.classList.add('mk-hover');
        }
      }
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const d = this.dragging;
    if (!d || e.pointerId !== d.pointerId) return;
    this.dragging = null;
    d.piece.el.classList.remove('pc-drag');

    const target = this.squareFromPoint(e.clientX, e.clientY);

    // a click without movement leaves the piece selected for click-to-move
    if (!d.moved) { this.place(d.piece.el, d.piece.square); return; }

    if (!target || target === d.originSquare || !this.legalTargets.has(target)) {
      this.place(d.piece.el, d.piece.square);
      if (target && target !== d.originSquare) this.cb.onIllegal();
      this.clearSelection();
      this.renderMarkers();
      return;
    }

    this.clearSelection();
    this.renderMarkers();
    void this.commit(d.originSquare, target, d.piece);
  };

  /** Send a move, handling promotion, and snap back if the server rejects it. */
  private async commit(from: string, to: string, piece?: PieceEl): Promise<void> {
    const p = piece ?? this.pieces.get(from);
    let promotion: string | undefined;

    const isPawn = p?.code[1] === 'p';
    const lastRank = to[1] === '8' || to[1] === '1';
    if (isPawn && lastRank) {
      const choice = await this.cb.requestPromotion(p!.code[0] as 'w' | 'b');
      if (!choice) { if (p) this.place(p.el, p.square); return; }
      promotion = choice;
    }

    // optimistic slide so the piece tracks the cursor release immediately
    if (p) { p.square = to; this.place(p.el, to); }

    const ok = await this.cb.onMove(from, to, promotion);
    if (!ok) {
      this.cb.onIllegal();
      this.setPosition(this.chess.fen(), this.lastMove, false);
    }
  }

  destroy(): void {
    this.squaresLayer.removeEventListener('keydown', this.onKeyDown);
    this.squaresLayer.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }
}
