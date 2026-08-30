import './styles/theme.css';
import './styles/layout.css';
import './styles/controls.css';
import './styles/board.css';
import './styles/panels.css';
import './styles/chat.css';
import './styles/cards.css';
import './styles/turn.css';

import { renderHome } from './ui/home';
import { renderRoom } from './ui/room';
import { askName } from './ui/nameGate';
import { toast } from './ui/widgets';
import { connect, joinRoom, getName } from './net/socket';
import { setState, getState } from './state/store';

const app = document.getElementById('app')!;
let teardown: (() => void) | null = null;

connect();

/** Hash routing keeps the client a single static file with no server rewrite rules. */
function parseRoute(): string | null {
  const m = location.hash.match(/^#\/r\/([a-z0-9]+)/i);
  return m ? m[1].toLowerCase() : null;
}

async function route(): Promise<void> {
  teardown?.();
  teardown = null;

  const roomId = parseRoute();

  if (!roomId) {
    setState({
      room: null, you: null, orientationOverride: null, chat: [], marks: [],
      reviewPly: null, archived: null,
    });
    renderHome(app, id => { location.hash = `#/r/${id}`; });
    return;
  }

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
void route();

// A dropped socket re-joins the same room, and the token in localStorage reclaims the seat.
window.addEventListener('online', () => {
  const id = parseRoute();
  if (id && !getState().connected) void joinRoom(id, getName() || 'Player');   // reclaim by token
});
