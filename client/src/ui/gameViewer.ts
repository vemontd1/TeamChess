import { Board } from '../board/board';
import { renderMoves, modal } from './widgets';
import { escapeHtml } from '../util/format';
import { wireCharts } from './charts';
import { reportHtml } from './gameReport';
import { pgnUrl } from '../net/socket';
import { noteEvent } from '../net/telemetry';
import { START_FEN } from '../state/store';
import type { ArchivedGame, Color, HistoryEntry } from '../types';

/**
 * A finished game, replayed.
 *
 * The archive stores the FEN each ply produced, so this is a seek rather than a replay:
 * stepping to move 14 reads one string out of an array. Nothing here runs a move
 * generator, which is why it can open a hundred-ply game instantly and why a position it
 * shows is exactly the position that was played rather than a reconstruction of it.
 *
 * The live room has its own review built into the move list, because there the board is
 * already on screen and only needs a lens over it. This is the other case -- a game from
 * a profile, with no room and no board -- so it brings its own of both.
 *
 * It also holds the **report**: the same game read as measurements rather than as moves.
 * The two live in one window because they are two views of one thing, and a player who
 * wants to know why a game went the way it did will want both within a click of each
 * other.
 */

interface Frame {
  fen: string;
  lastMove: { from: string; to: string } | null;
  label: string;
}

function framesOf(game: ArchivedGame): Frame[] {
  const frames: Frame[] = [{
    fen: game.startFen || START_FEN,
    lastMove: null,
    label: 'Starting position',
  }];
  for (const e of game.history) {
    frames.push({
      fen: e.fen,
      lastMove: { from: e.from, to: e.to },
      label: `${Math.ceil(e.ply / 2)}${e.color === 'white' ? '.' : '…'} ${e.san}`
        + `  ${e.playerName}`,
    });
  }
  return frames;
}

function resultLine(game: ArchivedGame): string {
  const head = game.result === 'white' ? 'White wins'
    : game.result === 'black' ? 'Black wins'
    : game.result === 'draw' ? 'Draw' : 'Unfinished';
  return `${head} — ${game.reason}`;
}

export interface ViewerOptions {
  /** Which view opens first. The report is the interesting one straight after a game. */
  view?: 'replay' | 'report';
  /** Whose report it is. Null for a spectator, which reads it from White's side. */
  you?: Color | null;
}

/** Open the replay. Returns a closer, in case the caller has to tear it down itself. */
export function openGameViewer(game: ArchivedGame, opts: ViewerOptions = {}): () => void {
  const frames = framesOf(game);
  let view: 'replay' | 'report' = opts.view ?? 'replay';
  let unwireCharts: (() => void) | null = null;
  let at = frames.length - 1;
  // Ply 1 is White's, so a viewer with no seat of their own is best served looking from
  // whichever side is not obviously the spectator's -- White, as the board's default.
  let orient: Color = 'white';

  const { host, close } = modal(`
    <div class="viewer">
      <div class="viewer-head">
        <div>
          <div class="viewer-title">${escapeHtml(game.white.join(', ') || '?')}
            <span class="viewer-vs">vs</span>
            ${escapeHtml(game.black.join(', ') || '?')}</div>
          <div class="viewer-sub">${escapeHtml(resultLine(game))} ·
            ${game.config.mode === 'cards' ? 'Chess Cards' : 'Team Chess'} ·
            ${new Date(game.finishedAt).toLocaleDateString()}</div>
        </div>
        <div class="viewer-views">
          <button class="viewer-view" data-view="replay">Replay</button>
          <button class="viewer-view" data-view="report">Report</button>
        </div>
        <button class="btn btn-sm btn-icon btn-ghost" id="vwflip" title="Flip board">⇅</button>
        <button class="btn btn-sm btn-ghost" id="vwclose">Close</button>
      </div>

      <div class="viewer-report" id="vwreport" hidden></div>

      <div class="viewer-body">
        <div class="viewer-board" id="vwboard"></div>
        <div class="viewer-side">
          <div class="review-bar">
            <button class="btn btn-sm btn-icon btn-ghost" id="vwfirst" title="Start (Home)">⏮</button>
            <button class="btn btn-sm btn-icon btn-ghost" id="vwprev" title="Back (←)">◀</button>
            <button class="btn btn-sm btn-icon btn-ghost" id="vwnext" title="Forward (→)">▶</button>
            <button class="btn btn-sm btn-icon btn-ghost" id="vwlast" title="End (End)">⏭</button>
            <span class="review-at" id="vwat"></span>
          </div>
          <div class="moves viewer-moves" id="vwmoves"></div>
          <div class="viewer-foot">
            <a class="btn btn-sm btn-ghost" href="${pgnUrl(game.id)}"
               target="_blank" rel="noopener">Download PGN</a>
          </div>
        </div>
      </div>
    </div>`);

  host.querySelector('.modal')!.classList.add('modal-wide');

  const boardHost = host.querySelector<HTMLElement>('#vwboard')!;
  const board = new Board(boardHost, {
    // A finished game is not playable, so every gesture that would change it is a no-op
    // rather than something the board has to be told to disable twice.
    onMove: async () => false,
    onIllegal: () => {},
    onPickup: () => {},
    requestPromotion: async () => null,
  });
  board.setInteractive(false, null);

  const sizeBoard = (): void => {
    const wide = window.innerWidth > 900;
    const size = Math.max(240, Math.min(
      wide ? 420 : window.innerWidth - 80,
      window.innerHeight - 260,
    ));
    boardHost.style.setProperty('--board-size', `${Math.round(size)}px`);
  };
  sizeBoard();
  window.addEventListener('resize', sizeBoard);

  const atEl = host.querySelector<HTMLElement>('#vwat')!;
  const movesEl = host.querySelector<HTMLElement>('#vwmoves')!;
  const reportEl = host.querySelector<HTMLElement>('#vwreport')!;
  const bodyEl = host.querySelector<HTMLElement>('.viewer-body')!;
  const flipBtn = host.querySelector<HTMLElement>('#vwflip')!;

  /**
   * The report is rendered once, on first sight of it.
   *
   * Not up front: most openings of this window are somebody stepping through a game, and
   * a report that nobody looks at is a material graph drawn for nothing.
   */
  const showView = (): void => {
    const report = view === 'report';
    if (report && !reportEl.dataset.drawn) {
      reportEl.innerHTML = reportHtml(game, opts.you ?? null);
      reportEl.dataset.drawn = '1';
      unwireCharts?.();
      unwireCharts = wireCharts(reportEl);
    }
    reportEl.hidden = !report;
    bodyEl.hidden = report;
    flipBtn.hidden = report;
    host.querySelectorAll<HTMLElement>('.viewer-view').forEach(b => {
      b.classList.toggle('on', b.dataset.view === view);
    });
  };

  host.querySelectorAll<HTMLButtonElement>('.viewer-view').forEach(b => {
    b.addEventListener('click', () => {
      view = b.dataset.view as 'replay' | 'report';
      showView();
    });
  });

  const paint = (): void => {
    at = Math.max(0, Math.min(frames.length - 1, at));
    const f = frames[at];
    board.setOrientation(orient);
    board.setPosition(f.fen, f.lastMove, inCheckAt(game.history, at));
    atEl.textContent = f.label;
    renderMoves(movesEl, game.history, { at, onPick: ply => { at = ply; paint(); } });

    const dis = (id: string, off: boolean): void => {
      const b = host.querySelector<HTMLButtonElement>(id);
      if (b) b.disabled = off;
    };
    dis('#vwfirst', at === 0);
    dis('#vwprev', at === 0);
    dis('#vwnext', at === frames.length - 1);
    dis('#vwlast', at === frames.length - 1);
  };

  const go = (to: number): void => { at = to; paint(); };
  host.querySelector('#vwfirst')!.addEventListener('click', () => go(0));
  host.querySelector('#vwprev')!.addEventListener('click', () => go(at - 1));
  host.querySelector('#vwnext')!.addEventListener('click', () => go(at + 1));
  host.querySelector('#vwlast')!.addEventListener('click', () => go(frames.length - 1));
  host.querySelector('#vwflip')!.addEventListener('click', () => {
    orient = orient === 'white' ? 'black' : 'white';
    paint();
  });

  const shut = (): void => {
    window.removeEventListener('resize', sizeBoard);
    window.removeEventListener('keydown', onKey);
    unwireCharts?.();
    board.destroy();
    close();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(at - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(at + 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(frames.length - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); shut(); }
  };
  window.addEventListener('keydown', onKey);

  host.querySelector('#vwclose')!.addEventListener('click', shut);
  host.addEventListener('click', e => { if (e.target === host) shut(); });

  paint();
  showView();
  // Stepping back through a finished game is one of the few things only the client can
  // see, and it is the question "does anyone review?" answered rather than guessed.
  noteEvent('review');
  return shut;
}

/** The SAN carries the check, which is the only place a stored ply records one. */
function inCheckAt(history: HistoryEntry[], at: number): boolean {
  return at > 0 && /[+#]$/.test(history[at - 1]?.san ?? '');
}
