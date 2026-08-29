import { Board } from '../board/board';
import { TeamPanel } from './teamPanel';
import { ChatPanel } from './chat';
import { TimerRing, escapeHtml } from './timerRing';
import {
  renderTray, renderMoves, renderStats, toast, autoMoveBanner, modal, promotionDialog,
} from './widgets';
import { sfx, setSoundEnabled, unlockAudio } from '../audio/sfx';
import { showTurnAlert, clearTurnAlert } from './turnAlert';
import { CardHand, reachOf, typesForKind, EMERGENCY_CARD_ID } from './cardHand';
import { effectsEnabled, toggleMotion, systemPrefersReduced, getMotionPref, motionLevel } from '../state/motion';
import * as net from '../net/socket';
import {
  getState, setState, subscribe, orientation, isMyTurn, mustAnswerTakeback,
  canRequestTakeback, canOfferDraw, canEndGame, mustAnswerDraw, isSeated, isCardsMode,
  type AppState,
} from '../state/store';
import type { Color, RoomState, MoveFx, ChatChannel, HistoryEntry } from '../types';

export function renderRoom(root: HTMLElement, roomId: string, onLeave: () => void): () => void {
  root.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand"><b>Bolotnoye Logovo</b><span id="mode-name">Team Chess</span></div>
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
          <div id="cards"></div>
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
  const cardsHost = root.querySelector<HTMLElement>('#cards')!;

  // ---- board sizing ------------------------------------------------------
  //
  // The board takes whatever the window has left after everything that shares the column
  // with it. The height it can have is *measured* rather than guessed at with a constant:
  // the tray, the card hand and the button row all have sizes that do not depend on the
  // board, so reading them back is both exact and self-correcting -- adding a row under
  // the board can never again quietly push it off the bottom of the screen.
  //
  // The cap is a share of the viewport rather than a fixed pixel count. A 620px ceiling
  // is right on a laptop and absurd on a 27-inch monitor, where it left the game sitting
  // in the middle of the display with the rest unused.

  const uiScale = (): number => {
    const v = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--ui'));
    return Number.isFinite(v) && v > 0 ? v : 1;
  };

  const heightOf = (el: HTMLElement | null): number =>
    el && !el.hidden ? el.getBoundingClientRect().height : 0;

  const sizeBoard = (): void => {
    const ui = uiScale();
    const w = window.innerWidth;
    const stacked = w <= 1180;   // the side columns drop under the board below this

    // width: the page padding and, on a wide screen, both side columns and the gaps
    const pagePad = 2 * 26 * ui;
    const columns = stacked ? 0 : (280 + 320 + 2 * 26) * ui;
    const availW = w - pagePad - columns - 8;

    // height: everything else in the board column, measured
    const topbar = heightOf(root.querySelector<HTMLElement>('.topbar'));
    const siblings = heightOf(trayEl.closest('.panel'))
      + heightOf(cardsHost) + heightOf(controls);
    const colGaps = 16 * ui * 2;
    const measured = window.innerHeight - topbar - siblings - colGaps - pagePad;
    // before the first paint the measurements are zero; fall back to a sane guess
    const availH = siblings > 0 ? measured : window.innerHeight - 260 * ui;

    // Two ceilings: never more than 84% of the window height, so the board is never the
    // only thing on screen, and a generous absolute cap that itself grows with the scale.
    const cap = Math.min(window.innerHeight * 0.84, 1040 * ui);

    const size = Math.max(300, Math.min(availW, availH, cap));
    boardHost.style.setProperty('--board-size', `${Math.round(size)}px`);
  };

  sizeBoard();
  // measurements are only real once the column has been laid out
  requestAnimationFrame(() => requestAnimationFrame(sizeBoard));
  window.addEventListener('resize', sizeBoard);

  /** Announce to screen readers what the visuals say in colour and motion. */
  const announce = (msg: string): void => {
    liveRegion.textContent = liveRegion.textContent === msg ? `${msg} ` : msg;
  };

  const board = new Board(boardHost, {
    onMove: async (from, to, promotion) => {
      // An explicit pick is honoured; with none, the server spends the cheapest card that
      // covers the piece, which is always the one the player would have chosen.
      const cardId = cardHand.selection() ?? undefined;
      const ok = await net.sendMove({ from, to, promotion, cardId });
      if (ok) cardHand.clearSelection();
      return ok;
    },
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

  /**
   * Hovering a card previews its reach on the board without committing to it; clicking
   * narrows the board to that card until the move is made or the pick is dropped.
   */
  let hoverCardId: number | null = null;
  const applyReach = (): void => {
    const s = getState();
    if (!isCardsMode(s) || !isMyTurn(s)) { board.setAllowedTypes(null); return; }
    if (hoverCardId != null) {
      const card = s.hand?.cards.find(c => c.id === hoverCardId);
      board.setAllowedTypes(hoverCardId === EMERGENCY_CARD_ID
        ? new Set(['k', 'p', 'n', 'b', 'r', 'q'])
        : card
          ? new Set(['k', ...typesForKind(card.kind)])
          : reachOf(s.hand));
      return;
    }
    board.setAllowedTypes(cardHand.reach() ?? reachOf(s.hand));
  };

  const cardHand = new CardHand({
    onSelect: () => { applyReach(); sfx.click(); },
    onHover: id => { hoverCardId = id; applyReach(); },
    onMulligan: () => { unlockAudio(); net.mulligan(); },
    // one cue for the batch: five cards dealing in should sound like a deal, not five
    onDeal: () => { if (getState().soundOn) sfx.cardPlay(); },
  });
  cardsHost.appendChild(cardHand.el);

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
  // The move list is the panel that takes the slack in the right column; the chat log
  // does the same on the left. Both scroll, so growing them is free usefulness rather
  // than stretched whitespace.
  const movesPanel = panel('Move history', '<div class="moves" id="moves"></div>');
  movesPanel.classList.add('panel-grow');
  const statsPanel = panel('Player stats', '<div class="panel-body" id="stats"></div>');
  const timerPanel = document.createElement('section');
  timerPanel.className = 'panel edge sheen panel-fire';
  timerPanel.appendChild(timer.el);

  rosterStack.append(whitePanel.el, blackPanel.el);
  chat.el.classList.add('panel-grow');
  // In cards mode the chat goes (a team of one has no audience) and the table takes its
  // place, so the left column stays useful in both modes.
  leftCol.append(chat.el, cardHand.infoEl);
  rightCol.append(timerPanel, movesPanel, statsPanel);

  let takebackHost: HTMLElement | null = null;
  let tbRaf = 0;
  let gameOverShown = false;
  let lastHistoryLen = 0;
  let lastStatus: string | null = null;
  let myTurnAnnounced = false;
  let firstRender = true;
  let takebackWasPending = false;
  let drawWasPending = false;
  let drawRaf = 0;
  let drawHost: HTMLElement | null = null;
  let wasCardsMode: boolean | null = null;

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

  net.onHand(hand => setState({ hand }));

  net.onMulliganed(e => {
    const s = getState();
    const mine = s.you?.seat?.color === e.color;
    const who = e.color === 'white' ? 'White' : 'Black';
    toast(mine ? 'New hand dealt' : `${who} took a mulligan`);
    announce(mine ? 'You took a mulligan. New hand dealt.' : `${who} took a mulligan.`);
    if (s.soundOn) sfx.shuffle();
  });

  net.onDrawResolved(() => {
    toast('Draw declined');
    announce('The draw offer was declined');
    if (getState().soundOn) sfx.drawNo();
  });

  net.onGameEnded(e => {
    if (e.kind === 'resign') {
      const line = `${e.byName} resigned for ${e.byColor === 'white' ? 'White' : 'Black'}`;
      toast(line);
      announce(`${line}.`);
    } else {
      toast('Draw agreed');
      announce('The draw was agreed.');
    }
    // the endgame cue itself comes from the finished state in render(); this is the
    // gesture that caused it, which nothing else would report
    if (getState().soundOn && e.kind === 'resign') sfx.resign();
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

    // Cards mode narrows the board to what the hand can pay for; the team game never
    // restricts it, so the two share one board and one code path.
    const cardsMode = isCardsMode(s);
    if (cardsMode !== wasCardsMode) {
      wasCardsMode = cardsMode;
      root.querySelector('#mode-name')!.textContent = cardsMode ? 'Chess Cards' : 'Team Chess';
      sizeBoard();
    }

    cardsHost.hidden = !cardsMode;
    cardHand.infoEl.hidden = !cardsMode;
    if (isCardsMode(s)) {
      cardHand.render(s.hand, room.cards, s.you?.seat?.color ?? null);
      applyReach();
    } else {
      board.setAllowedTypes(null);
    }

    renderTray(trayEl, room.fen);
    renderMoves(root.querySelector<HTMLElement>('#moves')!, room.history);
    renderStats(root.querySelector<HTMLElement>('#stats')!, room);

    const isHost = s.you?.isHost === true;
    whitePanel.render(room.white, room, s.you, isHost);
    blackPanel.render(room.black, room, s.you, isHost);
    orderRosters(rosterStack, whitePanel.el, blackPanel.el, orientation(s));

    // A 1v1 duel gives a seated player a team channel of exactly themselves. Spectators
    // still have each other, so the panel stays for them and goes for the players.
    chat.el.hidden = isCardsMode(s) && isSeated(s);

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
      room.turnRemainingMs,
      room.config.moveTimerSec,
      room.status === 'playing' ? room.activePlayerName : null,
      activeTeam,
      room.pendingTakeback != null,
    );

    renderControls(s, isHost);
    renderTakeback(s);
    renderDrawOffer(s);

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

    // a draw offer is likewise a question aimed at the other side
    const draw = room.pendingDraw;
    if (draw && !drawWasPending) {
      announce(`${draw.byName} offered a draw`);
      if (s.soundOn && s.you?.seat && s.you.seat.color !== draw.byColor) sfx.drawOffer();
    }
    drawWasPending = draw != null;

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
      // A team that is lost, or agreed on a draw, needs a way out that is not waiting for
      // mate. Both are open to any seated player, not just whoever is on the clock.
      if (canEndGame(s)) {
        parts.push(`<button class="btn btn-sm" id="drawoffer"
          ${canOfferDraw(s) ? '' : 'disabled'}>Offer draw</button>`);
        parts.push(`<button class="btn btn-sm btn-danger" id="resign">Resign</button>`);
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
    controls.querySelector('#drawoffer')?.addEventListener('click', () => {
      net.offerDraw();
      toast('Draw offered — waiting on your opponent');
      sfx.click();
    });
    // Resigning ends the game for the whole team and cannot be undone, so it asks first.
    controls.querySelector('#resign')?.addEventListener('click', () => {
      const side = s.you?.seat?.color === 'white' ? 'White' : 'Black';
      const { host, close } = modal(`
        <h2>Resign?</h2>
        <p>This ends the game for all of Team ${side}, not only for you. It cannot be
           taken back.</p>
        <div class="btn-row" style="justify-content:center;margin-top:20px">
          <button class="btn btn-danger" id="rsyes">Resign</button>
          <button class="btn btn-ghost" id="rsno">Keep playing</button>
        </div>`);
      host.querySelector('#rsno')!.addEventListener('click', close);
      host.querySelector('#rsyes')!.addEventListener('click', () => { close(); net.resign(); });
      host.addEventListener('click', e => { if (e.target === host) close(); });
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
    const fresh = !takebackHost;
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

    if (fresh) {
      const fill = takebackHost.querySelector<HTMLElement>('#tbfill')!;
      const total = 20_000;
      const endsAt = Date.now() + pending.remainingMs;
      const step = (): void => {
        const left = Math.max(0, endsAt - Date.now());
        const bar = takebackHost?.querySelector<HTMLElement>('#tbfill') ?? fill;
        bar.style.width = `${(left / total) * 100}%`;
        if (left > 0) tbRaf = requestAnimationFrame(step);
      };
      cancelAnimationFrame(tbRaf);
      step();
    }
  }

  /**
   * The draw prompt. Only the opposing team's active seat can answer it; everyone else
   * sees that the question is out, which matters in a team game where a teammate needs to
   * know an offer is on the table before they plan around it.
   */
  function renderDrawOffer(s: AppState): void {
    const pending = s.room?.pendingDraw ?? null;
    if (!pending) {
      cancelAnimationFrame(drawRaf); drawRaf = 0;
      drawHost?.remove(); drawHost = null;
      return;
    }
    const answerable = mustAnswerDraw(s);
    const fresh = !drawHost;
    if (!drawHost) {
      drawHost = document.createElement('section');
      drawHost.className = 'panel edge takeback';
      rightCol.prepend(drawHost);
    }
    drawHost.innerHTML = `
      <div class="panel-head"><span class="panel-title">Draw offered</span></div>
      <div class="panel-body">
        <p style="margin:0 0 12px;font-size:13.5px;color:var(--text-dim)">
          <b style="color:var(--text)">${escapeHtml(pending.byName)}</b>
          offers a draw.</p>
        ${answerable ? `<div class="btn-row">
          <button class="btn btn-sm btn-primary" id="dryes">Accept</button>
          <button class="btn btn-sm btn-danger" id="drno">Decline</button>
        </div>` : `<div style="font-size:12.5px;color:var(--text-faint)">
          Waiting on the opposing player to answer…</div>`}
        <div class="tb-bar"><div class="tb-fill" id="drfill"></div></div>
      </div>`;

    drawHost.querySelector('#dryes')?.addEventListener('click', () => net.respondDraw(true));
    drawHost.querySelector('#drno')?.addEventListener('click', () => net.respondDraw(false));

    // The countdown runs on this machine's clock from the duration the server sent, for
    // the same reason the turn clock does -- an absolute server epoch would skew.
    if (fresh) {
      const fill = drawHost.querySelector<HTMLElement>('#drfill')!;
      const total = 20_000;
      const endsAt = Date.now() + pending.remainingMs;
      const step = (): void => {
        const left = Math.max(0, endsAt - Date.now());
        const bar = drawHost?.querySelector<HTMLElement>('#drfill') ?? fill;
        bar.style.width = `${(left / total) * 100}%`;
        if (left > 0) drawRaf = requestAnimationFrame(step);
      };
      cancelAnimationFrame(drawRaf);
      step();
    }
  }

  function showGameOver(room: RoomState, isHost: boolean): void {
    const w = room.gameOver?.winner;
    const title = w === 'draw' ? 'Draw'
      : w === 'white' ? 'White wins'
      : w === 'black' ? 'Black wins' : 'Game over';
    const { host, close } = modal(`
      <div class="go-crown">${w === 'draw' ? '½' : '♔'}</div>
      <div class="go-result">${title}</div>
      <div class="go-reason">${escapeHtml(reasonLabel(room))}</div>
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
    cardHand.destroy();
    board.destroy();
    cancelAnimationFrame(tbRaf);
    cancelAnimationFrame(drawRaf);
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
  return `${head} — ${reasonLabel(room)}.`;
}

/** The reason as a phrase; the raw enum reads as a stub next to the result. */
function reasonLabel(room: RoomState): string {
  switch (room.gameOver?.reason) {
    case 'checkmate':    return 'checkmate';
    case 'stalemate':    return 'stalemate';
    case 'threefold':    return 'threefold repetition';
    case 'fifty-move':   return 'the fifty-move rule';
    case 'insufficient': return 'insufficient material';
    case 'resignation':  return 'resignation';
    case 'agreement':    return 'agreement';
    default:             return 'a draw';
  }
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
