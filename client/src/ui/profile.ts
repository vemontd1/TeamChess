import { escapeHtml } from './timerRing';
import { toast } from './widgets';
import { openGameViewer } from './gameViewer';
import * as net from '../net/socket';
import type { ProfileGame, ProfileView } from '../types';

/**
 * The signed-in player's record: a name, a tally, and the games behind it.
 *
 * Belongs to an account, which is the point of having accounts: the browser token this
 * used to hang on could not survive clearing the browser and could not follow anyone to a
 * second device. Guests see the sign-in panel here instead, and nothing is kept for them.
 *
 * Every row opens the game it names. That is the point of keeping them at all -- a record
 * of results you cannot look inside is a scoreboard, not a history.
 */

function relative(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(at).toLocaleDateString();
}

const RESULT_LABEL: Record<ProfileGame['yourResult'], string> = {
  win: 'W', loss: 'L', draw: 'D',
};

function gameRow(g: ProfileGame): string {
  const opp = g.opponents.join(', ') || 'nobody';
  const unfinished = g.result === 'unfinished';
  return `<button type="button" class="prof-game" data-id="${escapeHtml(g.id)}">
    <span class="prof-res prof-res-${unfinished ? 'none' : g.yourResult}"
          title="${unfinished ? 'Abandoned' : g.yourResult}">
      ${unfinished ? '–' : RESULT_LABEL[g.yourResult]}</span>
    <span class="prof-vs">vs <b>${escapeHtml(opp)}</b></span>
    <span class="prof-mode">${g.mode === 'cards' ? 'Cards' : 'Team'}</span>
    <span class="prof-plies">${g.plies} ply</span>
    <span class="prof-when">${escapeHtml(relative(g.finishedAt))}</span>
  </button>`;
}

/**
 * Render the panel into a host element, and fetch what goes in it.
 *
 * The fetch is fire-and-forget: a profile that cannot be read is not a reason to hold up
 * the home screen, so the panel simply stays hidden and the player creates a room as they
 * always did. Returns a setter, so the caller can hand it a profile it already has --
 * signing in returns one in the same round trip -- or pass null to reload.
 */
export function mountProfile(host: HTMLElement): (v?: ProfileView | null) => void {
  let view: ProfileView | null = null;

  const paint = (): void => {
    // Nothing to show until a game has actually been played. An empty record with a
    // zeroed tally is worse than no panel: it invites the reader to fix something that
    // is not broken.
    if (!view || view.games.length === 0) { host.hidden = true; host.innerHTML = ''; return; }

    host.hidden = false;
    const { profile, games } = view;
    const { wins, losses, draws } = profile.record;

    host.innerHTML = `
      <div class="panel-head">
        <span class="panel-title">Your games</span>
        <span class="prof-name">${escapeHtml(profile.name)}</span>
      </div>
      <div class="prof-record">
        <span class="prof-tally"><b>${wins}</b> won</span>
        <span class="prof-tally"><b>${draws}</b> drawn</span>
        <span class="prof-tally"><b>${losses}</b> lost</span>
        <span class="prof-note" title="Signed in, so this record follows you to any
          browser or device">your account</span>
      </div>
      <div class="prof-games">${games.map(gameRow).join('')}</div>`;

    host.querySelectorAll<HTMLButtonElement>('.prof-game').forEach(b => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        const game = await net.fetchGame(b.dataset.id!);
        b.disabled = false;
        if (!game) { toast('That game is no longer stored', 'danger'); return; }
        openGameViewer(game);
      });
    });
  };

  const load = (given?: ProfileView | null): void => {
    if (given !== undefined) { view = given; paint(); return; }
    void net.myProfile(20).then(res => { view = res; paint(); }).catch(() => {});
  };

  host.hidden = true;
  return load;
}
