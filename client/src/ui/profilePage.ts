import { renderAppBar, bindAppBar } from './appbar';
import { avatarHtml } from './avatar';
import { escapeHtml } from './timerRing';
import { toast } from './widgets';
import { openGameViewer } from './gameViewer';
import { renderActivityGrid, summarise } from './activityGrid';
import { sfx } from '../audio/sfx';
import * as net from '../net/socket';
import { getState, setState } from '../state/store';
import type { Account, ProfileGame, ProfileView } from '../types';

/**
 * The profile: who you are, when you play, and every game you have played.
 *
 * Three blocks, in the order the questions get asked. Who — an identity card with the
 * record and how it splits. When — a year of squares, which is the only thing here that
 * answers a question the tally cannot. What — the games themselves, each row a link back
 * into the board.
 *
 * Numbers are set in the UI face with tabular lining figures rather than in the display
 * serif. Cormorant's old-style figures hang below the baseline at uneven heights, which
 * in a column of stats reads as type stretched out of shape rather than as a typeface.
 */

function relative(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function longDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined,
    { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Plies are half-moves; a game is counted in the moves a player would say it lasted. */
function moveCount(plies: number): string {
  const moves = Math.ceil(plies / 2);
  return `${moves} ${moves === 1 ? 'move' : 'moves'}`;
}

const RESULT_WORD: Record<ProfileGame['yourResult'], string> = {
  win: 'Won', loss: 'Lost', draw: 'Drawn',
};

/** How a game ended, in words a player would use rather than the enum's. */
const REASON_WORD: Record<string, string> = {
  checkmate: 'by checkmate',
  resignation: 'by resignation',
  agreement: 'by agreement',
  stalemate: 'by stalemate',
  threefold: 'by repetition',
  'fifty-move': 'by the fifty-move rule',
  insufficient: 'for want of material',
  abandoned: 'abandoned',
};

function gameRow(g: ProfileGame, me: string): string {
  const opponents = g.opponents.join(', ') || 'nobody';
  const unfinished = g.result === 'unfinished';
  const kind = unfinished ? 'none' : g.yourResult;
  const asWhite = g.yourColor === 'white';

  return `<button type="button" class="game-row game-row-${kind}"
                  data-id="${escapeHtml(g.id)}">
    <span class="game-players">
      <span class="game-side">
        <span class="game-dot ${asWhite ? 'dot-w' : 'dot-b'}"
              title="You played ${asWhite ? 'White' : 'Black'}"></span>
        ${avatarHtml(me, 'sm')}<span class="game-name">${escapeHtml(me)}</span>
      </span>
      <span class="game-vs">vs</span>
      <span class="game-side">
        ${avatarHtml(opponents, 'sm')}<span class="game-name">${escapeHtml(opponents)}</span>
      </span>
    </span>
    <span class="game-meta">
      <span class="game-mode ${g.mode === 'cards' ? 'mode-cards' : 'mode-team'}">
        ${g.mode === 'cards' ? 'Cards' : 'Team'}</span>
      <span class="game-plies">${moveCount(g.plies)}</span>
    </span>
    <span class="game-when">${escapeHtml(relative(g.finishedAt))}</span>
    <span class="game-res game-res-${kind}">
      <b>${unfinished ? 'Unfinished' : RESULT_WORD[g.yourResult]}</b>
      <i>${escapeHtml(REASON_WORD[g.reason] ?? g.reason)}</i>
    </span>
  </button>`;
}

function emptyList(): string {
  return `<div class="games-empty">
    <div class="games-empty-mark">♟</div>
    <p>No games yet. Finish one and it lands here — every row opens the board again,
       move by move.</p>
    <a class="btn btn-primary" href="#/">Start a game</a>
  </div>`;
}

export function renderProfile(root: HTMLElement, account: Account): () => void {
  const draw = (view: ProfileView | null, loading: boolean): void => {
    const name = view?.profile.name ?? account.username;
    const rec = view?.profile.record ?? { wins: 0, losses: 0, draws: 0 };
    const games = view?.games ?? [];
    const activity = view?.activity ?? {};
    const act = summarise(activity);

    const played = rec.wins + rec.losses + rec.draws;
    const decisive = rec.wins + rec.losses;
    const winRate = decisive > 0 ? Math.round((rec.wins / decisive) * 100) : 0;
    const cards = games.filter(g => g.mode === 'cards').length;
    const team = games.length - cards;
    const lastPlayed = games[0]?.finishedAt ?? null;
    const backTo = getState().lastRoomId;

    // Percentages of the whole, so the three segments always fill the bar exactly.
    const pct = (n: number): number => (played > 0 ? (n / played) * 100 : 0);

    root.innerHTML = `
      ${renderAppBar(account, { active: 'profile' })}
      <div class="page">
        ${backTo ? `<a class="back-strip" href="#/r/${escapeHtml(backTo)}">
          <span class="back-arrow">←</span>
          <span>Back to your game <b>${escapeHtml(backTo.toUpperCase())}</b></span>
        </a>` : ''}

        <section class="panel edge sheen prof-hero">
          <div class="prof-face">
            ${avatarHtml(name, 'lg')}
            <div class="prof-id">
              <h1>${escapeHtml(name)}</h1>
              <div class="prof-since">
                Joined ${escapeHtml(longDate(account.createdAt))}
                ${lastPlayed ? ` · last played ${escapeHtml(relative(lastPlayed))}` : ''}
              </div>
            </div>
            <button class="btn btn-sm btn-ghost prof-out" id="pf-out">Sign out</button>
          </div>

          ${played === 0 ? '' : `
          <div class="prof-stats">
            <div class="stat"><b>${played}</b><span>played</span></div>
            <div class="stat stat-win"><b>${rec.wins}</b><span>won</span></div>
            <div class="stat"><b>${rec.draws}</b><span>drawn</span></div>
            <div class="stat stat-loss"><b>${rec.losses}</b><span>lost</span></div>
            <div class="stat stat-rate">
              <b>${winRate}<em>%</em></b>
              <span title="Wins as a share of games that were not drawn">win rate</span>
            </div>
          </div>

          <div class="prof-bar" role="img"
               aria-label="${rec.wins} won, ${rec.draws} drawn, ${rec.losses} lost">
            <span class="bar-win" style="width:${pct(rec.wins)}%"></span>
            <span class="bar-draw" style="width:${pct(rec.draws)}%"></span>
            <span class="bar-loss" style="width:${pct(rec.losses)}%"></span>
          </div>

          <div class="prof-facts">
            ${team > 0 ? `<span><b>${team}</b> Team Chess</span>` : ''}
            ${cards > 0 ? `<span><b>${cards}</b> Chess Cards</span>` : ''}
            ${act.activeDays > 0 ? `<span><b>${act.activeDays}</b>
              ${act.activeDays === 1 ? 'day' : 'days'} played</span>` : ''}
            ${act.streak > 1 ? `<span><b>${act.streak}</b>-day streak</span>` : ''}
            ${act.busiest && act.busiest.count > 1
              ? `<span>best day <b>${act.busiest.count}</b></span>` : ''}
          </div>`}
        </section>

        ${played === 0 ? '' : `
        <section class="panel edge act-panel">
          <div class="panel-head">
            <span class="panel-title">Activity</span>
            <span class="act-sub">${act.total} ${act.total === 1 ? 'game' : 'games'}
              in the last year</span>
          </div>
          ${renderActivityGrid(activity)}
        </section>`}

        <section class="panel edge games-panel">
          <div class="panel-head">
            <span class="panel-title">Games</span>
            ${games.length > 0
              ? `<span class="games-count">${games.length} shown</span>` : ''}
          </div>
          ${loading
            ? '<div class="games-loading">Loading your games…</div>'
            : games.length === 0 ? emptyList()
            : `<div class="games-list">${games.map(g => gameRow(g, name)).join('')}</div>`}
        </section>
      </div>`;

    bindAppBar(root);

    root.querySelector('#pf-out')!.addEventListener('click', () => {
      net.logoutAccount();
      setState({ account: null, profile: null });
      sfx.click();
      location.hash = '#/';
    });

    root.querySelector('.back-strip')?.addEventListener('click', () => sfx.click());

    root.querySelectorAll<HTMLButtonElement>('.game-row').forEach(b => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        const game = await net.fetchGame(b.dataset.id!);
        b.disabled = false;
        if (!game) { toast('That game is no longer stored', 'danger'); return; }
        openGameViewer(game);
      });
    });
  };

  // Draw immediately from whatever the session resume already fetched, so arriving here
  // from a sign-in is not a spinner over data the client is already holding.
  const known = getState().profile;
  draw(known, known == null);

  let live = true;
  void net.myProfile(50).then(view => {
    if (!live) return;
    setState({ profile: view });
    draw(view, false);
  }).catch(() => { if (live) draw(getState().profile, false); });

  return () => { live = false; };
}
