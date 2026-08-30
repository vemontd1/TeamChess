import { renderAppBar, bindAppBar } from './appbar';
import { avatarHtml } from './avatar';
import { escapeHtml } from './timerRing';
import { toast } from './widgets';
import { openGameViewer } from './gameViewer';
import { sfx } from '../audio/sfx';
import * as net from '../net/socket';
import { getState, setState } from '../state/store';
import type { Account, ProfileGame, ProfileView } from '../types';

/**
 * The profile: who you are, and every game you have played.
 *
 * Laid out the way a chess site lays it out, because that is the shape people already
 * read: an identity block at the top, the tally beside it, and under that a dense list of
 * games where each row is one match and the whole row is a link into it. The value is in
 * the list, so the list gets the space.
 */

function relative(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(at).toLocaleDateString();
}

const RESULT_WORD: Record<ProfileGame['yourResult'], string> = {
  win: 'Won', loss: 'Lost', draw: 'Drawn',
};

/**
 * One game.
 *
 * Both players are named, with yours first, so a row reads as a pairing rather than as a
 * list of opponents -- and the result badge sits at the end where the eye lands last,
 * which is how a results column is scanned.
 */
function gameRow(g: ProfileGame, me: string): string {
  const opponents = g.opponents.join(', ') || 'nobody';
  const unfinished = g.result === 'unfinished';
  const kind = unfinished ? 'none' : g.yourResult;

  return `<button type="button" class="game-row" data-id="${escapeHtml(g.id)}">
    <span class="game-players">
      <span class="game-side">
        ${avatarHtml(me, 'sm')}<span class="game-name">${escapeHtml(me)}</span>
      </span>
      <span class="game-vs">vs</span>
      <span class="game-side">
        ${avatarHtml(opponents, 'sm')}<span class="game-name">${escapeHtml(opponents)}</span>
      </span>
    </span>
    <span class="game-mode">${g.mode === 'cards' ? 'Chess Cards' : 'Team Chess'}</span>
    <span class="game-plies">${Math.ceil(g.plies / 2)} moves</span>
    <span class="game-when">${escapeHtml(relative(g.finishedAt))}</span>
    <span class="game-res game-res-${kind}">${unfinished ? 'Unfinished' : RESULT_WORD[g.yourResult]}</span>
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
    const played = rec.wins + rec.losses + rec.draws;
    const games = view?.games ?? [];

    root.innerHTML = `
      ${renderAppBar(account, { active: 'profile' })}
      <div class="page">
        <section class="panel edge sheen prof-hero">
          ${avatarHtml(name, 'lg')}
          <div class="prof-id">
            <h1>${escapeHtml(name)}</h1>
            <div class="prof-since">Playing since
              ${new Date(account.createdAt).toLocaleDateString()}</div>
          </div>
          <div class="prof-tallies">
            <div class="tally"><b>${played}</b><span>played</span></div>
            <div class="tally tally-win"><b>${rec.wins}</b><span>won</span></div>
            <div class="tally"><b>${rec.draws}</b><span>drawn</span></div>
            <div class="tally tally-loss"><b>${rec.losses}</b><span>lost</span></div>
          </div>
          <button class="btn btn-sm btn-ghost prof-out" id="pf-out">Sign out</button>
        </section>

        <section class="panel edge games-panel">
          <div class="panel-head">
            <span class="panel-title">Games</span>
            ${games.length > 0 ? `<span class="games-count">${games.length} shown</span>` : ''}
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
  // from a sign-in is not a spinner over data the client is holding.
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
