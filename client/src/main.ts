import './styles/theme.css';
import './styles/layout.css';
import './styles/controls.css';
import './styles/board.css';
import './styles/panels.css';
import './styles/chat.css';
import './styles/cards.css';
import './styles/turn.css';
import './styles/account.css';

import { renderHome } from './ui/home';
import { renderRoom } from './ui/room';
import { renderLogin } from './ui/loginPage';
import { renderProfile } from './ui/profilePage';
import { askName } from './ui/nameGate';
import { toast } from './ui/widgets';
import { connect, joinRoom, getName, resumeSession } from './net/socket';
import { setState, getState } from './state/store';

const app = document.getElementById('app')!;
let teardown: (() => void) | null = null;

connect();

/** Hash routing keeps the client a single static file with no server rewrite rules. */
function parseRoute(): string | null {
  const m = location.hash.match(/^#\/r\/([a-z0-9]+)/i);
  return m ? m[1].toLowerCase() : null;
}

type Page = { kind: 'room'; id: string } | { kind: 'home' | 'login' | 'signup' | 'profile' };

function parsePage(): Page {
  const id = parseRoute();
  if (id) return { kind: 'room', id };
  const hash = location.hash.replace(/^#\/?/, '').toLowerCase();
  if (hash === 'login') return { kind: 'login' };
  if (hash === 'signup') return { kind: 'signup' };
  if (hash === 'profile') return { kind: 'profile' };
  return { kind: 'home' };
}

/** Leaving a room clears everything that belonged to it, whatever the next page is. */
function clearRoomState(): void {
  setState({
    room: null, you: null, orientationOverride: null, chat: [], marks: [],
    reviewPly: null, archived: null,
  });
}

async function route(): Promise<void> {
  teardown?.();
  teardown = null;

  const page = parsePage();

  if (page.kind !== 'room') {
    clearRoomState();
    const account = getState().account;

    if (page.kind === 'login' || page.kind === 'signup') {
      // Already signed in: the sign-in page has nothing to offer, so it becomes the
      // profile rather than a form that would sign you in as yourself again.
      if (account) { location.hash = '#/profile'; return; }
      teardown = renderLogin(app, page.kind);
      return;
    }

    if (page.kind === 'profile') {
      if (!account) { location.hash = '#/login'; return; }
      teardown = renderProfile(app, account);
      return;
    }

    renderHome(app, id => { location.hash = `#/r/${id}`; });
    return;
  }

  const roomId = page.id;

  // Someone who arrived on an invite link never saw the home screen's name field, so ask
  // for one before joining rather than seating them as "Player". Anyone who has played
  // before already has a name stored and goes straight in.
  const name = getName() || await askName(roomId);

  const res = await joinRoom(roomId, name);
  if (!res.ok) {
    toast(res.error ?? 'Could not join that room', 'danger');
    location.hash = '';
    return;
  }

  // chat and marks belong to the room being left, not the one being entered; the server
  // sends this room's backlog on join
  setState({
    you: res.you ?? null, room: res.state ?? null, orientationOverride: null,
    chat: [], marks: [],
    // a review is a lens over one room's game; entering another room is not that game
    reviewPly: null, archived: null,
  });
  teardown = renderRoom(app, roomId, () => { location.hash = ''; });
}

window.addEventListener('hashchange', () => { void route(); });

/**
 * Resolve the session before the first render.
 *
 * Every page outside the room draws a header that depends on it, so routing first would
 * paint "Log in / Sign up" and then swap it for the account a moment later on every cold
 * load. A session that cannot be resolved is simply a guest, so nothing here can keep the
 * app from starting.
 */
void resumeSession()
  .then(({ account, profile }) => setState({ account, profile }))
  .catch(() => {})
  .finally(() => { void route(); });

// A dropped socket re-joins the same room, and the token in localStorage reclaims the seat.
window.addEventListener('online', () => {
  const id = parseRoute();
  if (id && !getState().connected) void joinRoom(id, getName() || 'Player');   // reclaim by token
});
