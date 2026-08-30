import './styles/theme.css';
import './styles/layout.css';
import './styles/controls.css';
import './styles/board.css';
import './styles/panels.css';
import './styles/chat.css';
import './styles/cards.css';
import './styles/turn.css';
import './styles/account.css';
import './styles/charts.css';

import { renderHome } from './ui/home';
import { renderRoom } from './ui/room';
import { renderLogin } from './ui/loginPage';
import { renderProfile } from './ui/profilePage';
import { renderAdmin } from './ui/adminPage';
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

type Page = { kind: 'room'; id: string }
  | { kind: 'home' | 'login' | 'signup' | 'profile' | 'admin' };

function parsePage(): Page {
  const id = parseRoute();
  if (id) return { kind: 'room', id };
  const hash = location.hash.replace(/^#\/?/, '').toLowerCase();
  if (hash === 'login') return { kind: 'login' };
  if (hash === 'signup') return { kind: 'signup' };
  if (hash === 'profile') return { kind: 'profile' };
  if (hash === 'admin') return { kind: 'admin' };
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

    if (page.kind === 'admin') {
      if (!account) { location.hash = '#/login'; return; }
      // Whether this account may see anything is the server's call, made per request.
      teardown = renderAdmin(app, account);
      return;
    }

    renderHome(app, id => { location.hash = `#/r/${id}`; });
    return;
  }

  const roomId = page.id;

  // Someone who arrived on an invite link never saw the home screen's name field, so ask
  // for one before joining rather than seating them as "Player". Anyone who has played
  // before already has a name stored and goes straight in -- and a signed-in player is
  // named by their account, so asking them would be asking for something they cannot
  // change and the server would overrule anyway.
  const signedIn = getState().account;
  const name = signedIn?.username ?? getName() ?? '';
  const joinAs = name || await askName(roomId);

  const res = await joinRoom(roomId, joinAs);
  if (!res.ok) {
    toast(res.error ?? 'Could not join that room', 'danger');
    // A room that cannot be joined is not somewhere to go back to. Without this the
    // profile went on offering a room that no longer existed, and the offer was the
    // reason people kept ending up back at it.
    if (getState().lastRoomId === roomId) setState({ lastRoomId: null });
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
  setState({ lastRoomId: roomId });
  teardown = renderRoom(app, roomId, () => {
    // Exit leaves the room for good, so the offer to go back goes with it.
    setState({ lastRoomId: null });
    location.hash = '';
  });
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
