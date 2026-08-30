import { renderAppBar, bindAppBar } from './appbar';
import { avatarHtml } from './avatar';
import { escapeHtml } from './timerRing';
import { toast } from './widgets';
import { openGameViewer } from './gameViewer';
import { renderActivityGrid, summarise } from './activityGrid';
import { columnChart, figure, fmtMs, fmtPct, wireCharts, type Series } from './charts';
import { FriendsPanel } from './friends';
import { sfx } from '../audio/sfx';
import * as net from '../net/socket';
import { getState, setState } from '../state/store';
import type { Account, ProfileGame, ProfileView } from '../types';

/**
 * The profile: who you are, when you play, how you have been playing, and every game.
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

/**
 * How you have been playing, game by game.
 *
 * The only place a *trend* can be drawn: a result list says who won, and says nothing
 * about whether your think time is creeping up or your pieces are being left where they
 * can be taken less often than they were. Each game carries its own side roll-up, so this
 * is read off the profile rather than reassembled from an archive that is capped anyway.
 *
 * Oldest on the left, because that is the direction time runs in. Only games that were
 * measured appear; a season that starts before metrics did simply starts later.
 */
function trends(games: ProfileGame[]): string {
  const measured = games.filter(g => g.you && g.you.moves > 0).slice(0, 30).reverse();
  if (measured.length < 3) return '';

  const cats = measured.map(g => new Date(g.finishedAt).toLocaleDateString(undefined,
    { day: 'numeric', month: 'short' }));
  const think: Series[] = [{
    name: 'Typical think time', color: '--viz-1',
    values: measured.map(g => g.you!.thinkMsMean),
  }];
  const care: Series[] = [{
    name: 'Pieces left hanging, per move', color: '--viz-2',
    values: measured.map(g => (g.you!.moves > 0 ? g.you!.hangs / g.you!.moves : 0)),
  }];
  const every = Math.max(1, Math.ceil(measured.length / 8));

  return `<section class="panel edge">
    <div class="panel-head"><span class="panel-title">How you have been playing</span>
      <span class="games-count">last ${measured.length} measured games</span></div>
    <div class="adm-figs">
      ${figure({
        title: 'Think time',
        note: 'Your mean over each game. Longer is not worse -- but a game you played at '
          + 'four times your usual pace is worth remembering when you read the result.',
        chart: columnChart({
          cats, series: think, format: n => fmtMs(n), catLabel: 'game',
          label: 'Mean think time per game, oldest first', labelEvery: every, height: 180,
        }),
      })}
      ${figure({
        title: 'Pieces left hanging',
        note: 'Per move, as a share. One ply deep and no recapture searched, so a trade '
          + 'counts here too -- watch the trend rather than any single game.',
        chart: columnChart({
          cats, series: care, format: n => fmtPct(n, 0), catLabel: 'game',
          label: 'Share of moves that left a piece hanging, per game, oldest first',
          labelEvery: every, height: 180,
        }),
      })}
    </div>
  </section>`;
}

export function renderProfile(root: HTMLElement, account: Account): () => void {
  let unwire: (() => void) | null = null;
  // Built once and moved into each redraw, so the list does not flicker or lose a
  // half-typed name every time a game row arrives.
  const friends = new FriendsPanel({ mode: 'follow' });
  const draw = (view: ProfileView | null, loading: boolean): void => {
    const name = view?.profile.name ?? account.username;
    const rec = view?.profile.record ?? { wins: 0, losses: 0, draws: 0 };
    const games = view?.games ?? [];
    const playedAt = view?.playedAt ?? [];
    const act = summarise(playedAt);

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

        <div id="pf-friends"></div>

        ${loading ? '' : trends(games)}

        ${played === 0 ? '' : `
        <section class="panel edge act-panel">
          <div class="panel-head">
            <span class="panel-title">Activity</span>
            <span class="act-sub">${act.total} ${act.total === 1 ? 'game' : 'games'}
              in the last year</span>
          </div>
          ${renderActivityGrid(playedAt)}
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
    root.querySelector('#pf-friends')?.appendChild(friends.el);
    unwire?.();
    unwire = wireCharts(root);

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

  return () => { live = false; unwire?.(); friends.destroy(); };
}
