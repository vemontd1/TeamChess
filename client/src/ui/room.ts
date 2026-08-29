import { Board } from '../board/board';
import { TeamPanel } from './teamPanel';
import { ChatPanel } from './chat';
import { TimerRing, escapeHtml } from './timerRing';
import {
  renderTray, renderMoves, renderStats, toast, autoMoveBanner, modal, promotionDialog,
} from './widgets';
import { sfx, setSoundEnabled, unlockAudio } from '../audio/sfx';
import { showTurnAlert, clearTurnAlert } from './turnAlert';
import { effectsEnabled, toggleMotion, systemPrefersReduced, getMotionPref, motionLevel } from '../state/motion';
import * as net from '../net/socket';
import {
  getState, setState, subscribe, orientation, isMyTurn, mustAnswerTakeback,
  canRequestTakeback, isSeated, type AppState,
} from '../state/store';
import type { Color, RoomState, MoveFx, ChatChannel, HistoryEntry } from '../types';

export function renderRoom(root: HTMLElement, roomId: string, onLeave: () => void): () => void {
  root.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand"><b>Bolotnoye Logovo</b><span>Team Chess</span></div>
        <div class="topbar-spacer"></div>
        <div class="conn"><span class="conn-dot"></span><span class="conn-text">Connected</span></div>
        <button class="btn btn-sm btn-ghost" id="copy" title="Copy the invite link">
          <span class="room-code">${escapeHtml(roomId)}</span></button>
        <button class="btn btn-sm btn-icon btn-ghost" id="flip" title="Flip board (F)">⇅</button>
        <button class="btn btn-sm btn-icon btn-ghost" id="sound" title="Toggle sound (M)">♪</button>
        <button class="btn btn-sm btn-icon btn-ghost" id="fx" title="Toggle visual effects (E)">✦</button>
        <button class="btn btn-sm btn-ghost" id="exit">Exit</button>
      </header>

      <div class="sr-only" id="live" role="status" aria-live="polite"></div>

      <div class="room-layout">
        <div class="side-column" id="left"><div class="roster-stack" id="rosters"></div></div>

        <div class="board-column">
          <section class="panel edge" style="width:100%"><div class="tray" id="tray"></div></section>
          <div id="board"></div>
          <div class="btn-row" id="controls"></div>
        </div>

        <div class="side-column" id="right"></div>
      </div>
    </div>`;

  const boardHost = root.querySelector<HTMLElement>('#board')!;
  const leftCol = root.querySelector<HTMLElement>('#left')!;
  const rosterStack = root.querySelector<HTMLElement>('#rosters')!;
  const liveRegion = root.querySelector<HTMLElement>('#live')!;
  const rightCol = root.querySelector<HTMLElement>('#right')!;
  const trayEl = root.querySelector<HTMLElement>('#tray')!;
  const controls = root.querySelector<HTMLElement>('#controls')!;

  // ---- board sizing: fit the viewport without letting the board dominate wide screens
  const sizeBoard = (): void => {
    const w = window.innerWidth;
    const avail = w > 1180 ? Math.min(w - 640, 620) : Math.min(w - 40, 560);
    const h = window.innerHeight - 250;
    boardHost.style.setProperty('--board-size', `${Math.max(280, Math.min(avail, h))}px`);
  };
  sizeBoard();
  window.addEventListener('resize', sizeBoard);

  /** Announce to screen readers what the visuals say in colour and motion. */
  const announce = (msg: string): void => {
    liveRegion.textContent = liveRegion.textContent === msg ? `${msg} ` : msg;
  };

  const board = new Board(boardHost, {
    onMove: (from, to, promotion) => net.sendMove({ from, to, promotion }),
    onIllegal: () => sfx.illegal(),
    onPickup: () => sfx.pickup(),
    requestPromotion: promotionDialog,
    onMark: square => {
      if (!isSeated(getState())) {
        toast('Only a seated player can mark squares');
        return;
      }
      net.toggleMark(square);
    },
  });

  const timer = new TimerRing();

  const teamHandlers = {
    onTake: async (color: Color, seatId: number) => {
      unlockAudio();
      const res = await net.takeSeat(color, seatId);
      if (!res.ok) toast(res.error ?? 'Could not take that seat', 'danger');
      else setState({ you: res.you ?? null });
    },
    onLeave: () => { net.leaveSeat(); setState({ you: getState().you && { ...getState().you!, seat: null } }); },
    onToggleBot: (color: Color, seatId: number, bot: boolean) => net.setSeatBot(color, seatId, bot),
  };

  const whitePanel = new TeamPanel('white', teamHandlers);
  const blackPanel = new TeamPanel('black', teamHandlers);

  const chat = new ChatPanel({
    onSend: text => { unlockAudio(); net.sendChat(text); },
  });

  // Left column: both rosters, oriented so your team sits nearest you.
  const movesPanel = panel('Move history', '<div class="moves" id="moves"></div>');
  const statsPanel = panel('Player stats', '<div class="panel-body" id="stats"></div>');
  const timerPanel = document.createElement('section');
  timerPanel.className = 'panel edge sheen panel-fire';
  timerPanel.appendChild(timer.el);

  rosterStack.append(whitePanel.el, blackPanel.el);
  leftCol.append(chat.el);
  rightCol.append(timerPanel, movesPanel, statsPanel);

  let takebackHost: HTMLElement | null = null;
  let tbRaf = 0;
  let gameOverShown = false;
  let lastHistoryLen = 0;
  let lastStatus: string | null = null;
  let myTurnAnnounced = false;
  let firstRender = true;
  let takebackWasPending = false;

  // ---- socket side effects -------------------------------------------------

  net.onFx((fx: MoveFx) => {
    const s = getState();
    if (!s.soundOn) return;
    if (fx.auto) sfx.timeout();
    else if (fx.promotion) sfx.promote();
    else if (fx.castle) sfx.castle();
    else if (fx.captured) sfx.capture();
    else sfx.move();
    if (fx.check) setTimeout(() => sfx.check(), 130);
  });

  net.onGameStart(() => {
    gameOverShown = false;
    myTurnAnnounced = false;
    if (getState().soundOn) sfx.start();
  });

  net.onSeatJoin(() => { if (getState().soundOn) sfx.seatJoin(); });

  net.onTakebackResolved(r => {
    toast(r.accepted ? 'Takeback accepted — move rewound' : 'Takeback declined');
    announce(r.accepted ? 'Takeback accepted, the move was rewound' : 'Takeback declined');
    if (getState().soundOn) {
      if (r.accepted) sfx.takebackYes(); else sfx.takebackNo();
    }
  });

  // Chat and marks arrive on their own channels: the server sends each socket only what
  // its own team may see, so there is nothing to filter here.
  net.onChatHistory(msgs => setState({ chat: msgs }));

  net.onChat(msg => {
    const s = getState();
    setState({ chat: [...s.chat, msg] });
    // the chat log is itself a live region, so it announces the message; this only has
    // to make the noise that says one arrived
    if (msg.name !== s.you?.name && s.soundOn) sfx.chat();
  });

  net.onMarks(marks => {
    // The board is told first: setState re-renders synchronously and would hand the board
    // the same marks, leaving nothing for the diff below to notice.
    const { added, changed } = board.setMarks(marks);
    if (changed && added.length > 0 && getState().soundOn) {
      sfx.mark(added.every(m => m.own));
    }
    setState({ marks });
  });

  // ---- render --------------------------------------------------------------

  function render(s: AppState): void {
    const room = s.room;
    if (!room) return;

    // connection pill
    const conn = root.querySelector<HTMLElement>('.conn')!;
    conn.classList.toggle('off', !s.connected);
    conn.querySelector('.conn-text')!.textContent = s.connected ? 'Connected' : 'Reconnecting…';

    // board
    board.setOrientation(orientation(s));
    board.setPosition(room.fen, room.lastMove, room.inCheck);
    board.setInteractive(isMyTurn(s), s.you?.seat ? (s.you.seat.color === 'white' ? 'w' : 'b') : null);

    board.setMarks(s.marks);

    renderTray(trayEl, room.fen);
    renderMoves(root.querySelector<HTMLElement>('#moves')!, room.history);
    renderStats(root.querySelector<HTMLElement>('#stats')!, room);

    const isHost = s.you?.isHost === true;
    whitePanel.render(room.white, room, s.you, isHost);
    blackPanel.render(room.black, room, s.you, isHost);
    orderRosters(rosterStack, whitePanel.el, blackPanel.el, orientation(s));

    const channel: ChatChannel = s.you?.seat?.color ?? 'spectator';
    chat.setChannel(channel, isSeated(s));
    chat.setEnabled(s.connected);
    chat.setMessages(s.chat, s.you?.name ?? '');

    // timer
    const activeTeam = room.activeColor === 'white' ? 'Team White'
      : room.activeColor === 'black' ? 'Team Black' : statusLabel(room);
    timer.setSound(s.soundOn);
    timer.update(
      room.turnDeadline,
      room.config.moveTimerSec,
      room.status === 'playing' ? room.activePlayerName : null,
      activeTeam,
      room.pendingTakeback != null,
    );

    renderControls(s, isHost);
    renderTakeback(s);

    // Your move: screen bloom + board pulse + chime, once on the transition into
    // your turn. Not fired on the very first render after joining, which would
    // announce a turn the player has been sitting in the whole time.
    if (isMyTurn(s)) {
      if (!myTurnAnnounced) {
        myTurnAnnounced = true;
        if (!firstRender) {
          showTurnAlert(s.you?.name ?? null, boardHost);
          announce('Your move.');
          if (s.soundOn) sfx.yourTurn();
        }
      }
    } else if (myTurnAnnounced) {
      myTurnAnnounced = false;
      clearTurnAlert();
    }
    firstRender = false;

    // a pending takeback is a question aimed at the opposing team; only they get the cue
    const pending = room.pendingTakeback;
    if (pending && !takebackWasPending) {
      announce(`${pending.byName} asked for a takeback`);
      if (s.soundOn && s.you?.seat && s.you.seat.color !== pending.byColor) sfx.takebackAsk();
    }
    takebackWasPending = pending != null;

    // timeout banner: fire on the transition, from the history entry the server recorded
    if (room.history.length > lastHistoryLen) {
      const last = room.history[room.history.length - 1];
      if (last) announce(describeMove(last, room.inCheck));
      if (last?.auto) {
        autoMoveBanner(last.playerName, last.san);
        boardHost.classList.add('board-flash', 'board-shake');
        setTimeout(() => boardHost.classList.remove('board-flash', 'board-shake'), 500);
      }
      lastHistoryLen = room.history.length;
    } else if (room.history.length < lastHistoryLen) {
      lastHistoryLen = room.history.length; // a takeback rewound the list
    }

    if (room.status === 'finished' && !gameOverShown) {
      gameOverShown = true;
      showGameOver(room, isHost);
      announce(gameOverLine(room));
      if (s.soundOn) playEndgame(room, s.you?.seat?.color ?? null);
    }
    if (room.status !== lastStatus) { lastStatus = room.status; }
  }

  function renderControls(s: AppState, isHost: boolean): void {
    const room = s.room!;
    const parts: string[] = [];

    if (room.status === 'lobby') {
      if (isHost) {
        const ready = room.white.seats.some(x => x.occupied)
          && room.black.seats.some(x => x.occupied);
        parts.push(`<button class="btn btn-primary" id="start" ${ready ? '' : 'disabled'}>
          ${ready ? 'Start game' : 'Need a player on each team'}</button>`);
      } else {
        parts.push(`<span style="color:var(--text-faint);font-size:13px;padding:9px 0">
          Waiting for the host to start…</span>`);
      }
    } else if (room.status === 'playing') {
      if (canRequestTakeback(s)) {
        parts.push(`<button class="btn btn-sm" id="tbreq">Request takeback</button>`);
      }
      if (isHost) {
        parts.push(`<button class="btn btn-sm btn-ghost" id="reset">Back to lobby</button>`);
      }
    } else if (room.status === 'finished' && isHost) {
      parts.push(`<button class="btn btn-primary btn-sm" id="rematch">Rematch</button>`);
      parts.push(`<button class="btn btn-sm btn-ghost" id="reset">Back to lobby</button>`);
    }

    controls.innerHTML = parts.join('');
    controls.querySelector('#start')?.addEventListener('click', () => net.startGame());
    controls.querySelector('#rematch')?.addEventListener('click', () => net.rematch());
    controls.querySelector('#reset')?.addEventListener('click', () => net.resetToLobby());
    controls.querySelector('#tbreq')?.addEventListener('click', () => {
      net.requestTakeback();
      toast('Takeback requested — waiting on your opponent');
    });
  }

  /** The pending-takeback prompt is only actionable for the opposing active player. */
  function renderTakeback(s: AppState): void {
    const pending = s.room?.pendingTakeback ?? null;
    if (!pending) {
      cancelAnimationFrame(tbRaf); tbRaf = 0;
      takebackHost?.remove(); takebackHost = null;
      return;
    }
    const answerable = mustAnswerTakeback(s);
    if (!takebackHost) {
      takebackHost = document.createElement('section');
      takebackHost.className = 'panel edge takeback';
      rightCol.prepend(takebackHost);
    }
    takebackHost.innerHTML = `
      <div class="panel-head"><span class="panel-title">Takeback requested</span></div>
      <div class="panel-body">
        <p style="margin:0 0 12px;font-size:13.5px;color:var(--text-dim)">
          <b style="color:var(--text)">${escapeHtml(pending.byName)}</b>
          wants to take back the last move.</p>
        ${answerable ? `<div class="btn-row">
          <button class="btn btn-sm btn-primary" id="tbyes">Accept</button>
          <button class="btn btn-sm btn-danger" id="tbno">Decline</button>
        </div>` : `<div style="font-size:12.5px;color:var(--text-faint)">
          Waiting on the opposing player to answer…</div>`}
        <div class="tb-bar"><div class="tb-fill" id="tbfill"></div></div>
      </div>`;

    takebackHost.querySelector('#tbyes')?.addEventListener('click', () => net.respondTakeback(true));
    takebackHost.querySelector('#tbno')?.addEventListener('click', () => net.respondTakeback(false));

    const fill = takebackHost.querySelector<HTMLElement>('#tbfill')!;
    const total = 20_000;
    const step = (): void => {
      const left = Math.max(0, pending.deadline - Date.now());
      fill.style.width = `${(left / total) * 100}%`;
      if (left > 0) tbRaf = requestAnimationFrame(step);
    };
    cancelAnimationFrame(tbRaf);
    step();
  }

  function showGameOver(room: RoomState, isHost: boolean): void {
    const w = room.gameOver?.winner;
    const title = w === 'draw' ? 'Draw'
      : w === 'white' ? 'White wins'
      : w === 'black' ? 'Black wins' : 'Game over';
    const { host, close } = modal(`
      <div class="go-crown">${w === 'draw' ? '½' : '♔'}</div>
      <div class="go-result">${title}</div>
      <div class="go-reason">${escapeHtml(room.gameOver?.reason ?? '')}</div>
      <div style="margin-top:20px" id="gostats"></div>
      <div class="btn-row" style="justify-content:center;margin-top:20px">
        ${isHost ? '<button class="btn btn-primary" id="goagain">Rematch</button>' : ''}
        <button class="btn btn-ghost" id="goclose">Close</button>
      </div>`);
    renderStats(host.querySelector<HTMLElement>('#gostats')!, room);
    host.querySelector('#goclose')!.addEventListener('click', close);
    host.querySelector('#goagain')?.addEventListener('click', () => { close(); net.rematch(); });
  }

  // ---- chrome controls ------------------------------------------------------

  root.querySelector('#copy')!.addEventListener('click', () => {
    const url = `${location.origin}/#/r/${roomId}`;
    void navigator.clipboard?.writeText(url);
    toast('Invite link copied');
    sfx.click();
  });

  const flip = (): void => {
    const s = getState();
    const cur = orientation(s);
    setState({ orientationOverride: cur === 'white' ? 'black' : 'white' });
    sfx.click();
  };
  root.querySelector('#flip')!.addEventListener('click', flip);

  const soundBtn = root.querySelector<HTMLButtonElement>('#sound')!;
  const toggleSound = (): void => {
    const on = !getState().soundOn;
    setState({ soundOn: on });
    setSoundEnabled(on);
    soundBtn.textContent = on ? '♪' : '✕';
    soundBtn.style.opacity = on ? '1' : '0.45';
    if (on) sfx.click();
  };
  soundBtn.addEventListener('click', toggleSound);

  const fxBtn = root.querySelector<HTMLButtonElement>('#fx')!;
  const paintFx = (on: boolean): void => {
    fxBtn.textContent = on ? '✦' : '✧';
    fxBtn.style.opacity = on ? '1' : '0.45';
    fxBtn.title = on ? 'Visual effects on (E)' : 'Visual effects off (E)';
  };
  paintFx(effectsEnabled());
  fxBtn.addEventListener('click', () => { paintFx(toggleMotion() !== 'off'); sfx.click(); });

  // Reduced-motion now dims the fire rather than removing it, so this is an offer of
  // more, not an apology for nothing.
  if (systemPrefersReduced() && getMotionPref() === 'auto' && motionLevel() === 'calm') {
    setTimeout(() => toast('Effects are gentle to match your system setting — press E for full fire'), 1400);
  }

  root.querySelector('#exit')!.addEventListener('click', onLeave);

  const onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'f' || e.key === 'F') flip();
    if (e.key === 'm' || e.key === 'M') toggleSound();
    if (e.key === 'e' || e.key === 'E') { paintFx(toggleMotion() !== 'off'); sfx.click(); }
    // C reaches the chat box, B reaches the board: the two things a keyboard player needs
    // to get between without hunting through the tab order.
    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      chat.el.querySelector<HTMLInputElement>('#chat-input')?.focus();
    }
    if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      boardHost.querySelector<HTMLElement>('.board-squares')?.focus();
    }
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('pointerdown', unlockAudio, { once: true });

  const unsub = subscribe(render);
  const s0 = getState();
  if (s0.room) render(s0);

  return () => {
    unsub();
    timer.destroy();
    board.destroy();
    cancelAnimationFrame(tbRaf);
    window.removeEventListener('resize', sizeBoard);
    window.removeEventListener('keydown', onKey);
  };
}

// ---- helpers ---------------------------------------------------------------

function panel(title: string, body: string): HTMLElement {
  const el = document.createElement('section');
  el.className = 'panel';
  el.innerHTML = `<div class="panel-head"><span class="panel-title">${title}</span></div>${body}`;
  return el;
}

/** Put the team matching the board's near side at the bottom of the roster column. */
function orderRosters(col: HTMLElement, white: HTMLElement, black: HTMLElement,
                      orient: 'white' | 'black'): void {
  const first = orient === 'white' ? black : white;
  const second = orient === 'white' ? white : black;
  if (col.firstElementChild !== first) col.append(first, second);
}

/** Spoken form of a ply: 'White, Anna played e4, check.' */
function describeMove(e: HistoryEntry, inCheck: boolean): string {
  const who = e.auto ? `${e.playerName} ran out of time, the board played`
    : `${e.playerName} played`;
  const team = e.color === 'white' ? 'White' : 'Black';
  return `${team}. ${who} ${e.san}.${inCheck ? ' Check.' : ''}`;
}

function gameOverLine(room: RoomState): string {
  const w = room.gameOver?.winner;
  const head = w === 'draw' ? 'Draw'
    : w === 'white' ? 'White wins'
    : w === 'black' ? 'Black wins' : 'Game over';
  return `${head}, by ${room.gameOver?.reason ?? 'agreement'}.`;
}

/**
 * Which of the three endgame cues you hear depends on your own result, not the board's.
 * A spectator has no result to hear, so they get the decisive one -- the game was won by
 * someone, even if not by them.
 */
function playEndgame(room: RoomState, mySide: Color | null): void {
  const w = room.gameOver?.winner;
  if (w == null || w === 'draw') { sfx.draw(); return; }
  if (mySide == null) { sfx.victory(); return; }
  if (w === mySide) sfx.victory(); else sfx.defeat();
}

function statusLabel(room: RoomState): string {
  return room.status === 'lobby' ? 'Waiting to start'
    : room.status === 'finished' ? 'Game over' : '';
}
