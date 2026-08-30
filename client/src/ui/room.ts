import { Board } from '../board/board';
import { TeamPanel } from './teamPanel';
import { ChatPanel } from './chat';
import { TimerRing, escapeHtml } from './timerRing';
import {
  renderTray, renderMoves, renderStats, toast, autoMoveBanner, modal, promotionDialog,
} from './widgets';
import { sfx, setSoundEnabled, unlockAudio } from '../audio/sfx';
import { showTurnAlert, clearTurnAlert } from './turnAlert';
import { showBloodBurst, clearBloodBurst } from './bloodBurst';
import { openBugReport } from './reportBug';
import { FriendsPanel, showInvite } from './friends';
import { avatarHtml } from './avatar';
import {
  CardHand, reachOf, heldReach, typesForKind, EMERGENCY_CARD_ID,
} from './cardHand';
import { effectsEnabled, toggleMotion, systemPrefersReduced, getMotionPref, motionLevel } from '../state/motion';
import * as net from '../net/socket';
import * as tel from '../net/telemetry';
import { openGameViewer } from './gameViewer';
import {
  getState, setState, subscribe, orientation, isMyTurn, mustAnswerTakeback,
  canRequestTakeback, canOfferDraw, canEndGame, mustAnswerDraw, isSeated, isCardsMode,
  shownPosition, isReviewing, setReviewPly, reviewAt, canMoveNow,
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
        <button class="btn btn-sm btn-icon btn-ghost" id="bug"
                title="Report a problem — the room and position go with it">⚑</button>
        <span id="who"></span>
        <button class="btn btn-sm btn-ghost" id="exit">Exit</button>
        <button class="btn btn-sm btn-icon btn-ghost" id="menu"
                aria-label="Open the side panels" aria-expanded="false">☰</button>
      </header>

      <div class="sr-only" id="live" role="status" aria-live="polite"></div>

      <div class="room-layout">
        <!-- display:contents on a desktop, so these two stay grid items in their own
             columns; a single off-canvas drawer on a phone, where there is no room for
             either and no way to reach them except by asking. -->
        <div class="side-wrap" id="sidewrap">
          <div class="drawer-head">
            <span>Panels</span>
            <span id="drawer-prefs"></span>
            <span id="drawer-exit"></span>
            <button class="btn btn-sm btn-ghost" id="drawer-close">Close</button>
          </div>
          <div class="btn-row drawer-actions" id="drawer-actions"></div>
          <div class="side-column" id="left"><div class="roster-stack" id="rosters"></div></div>
          <div class="side-column" id="right"></div>
        </div>

        <div class="board-column">
          <div id="phone-top"></div>
          <section class="panel edge tray-panel" style="width:100%">
            <div class="tray" id="tray"></div></section>
          <div class="board-stage" id="stage">
            <div id="board"></div>
            <!-- The lobby draws over the board rather than under it: there is nothing to
                 play yet, and the one button that matters should be where the eye already
                 is. Dimmed and blurred, the board reads as scenery instead of a game. -->
            <div class="board-veil" id="veil" hidden><div class="veil-inner" id="veil-in"></div></div>
          </div>
          <div id="cards"></div>
          <div class="constraint" id="constraint"></div>
          <div class="btn-row" id="controls"></div>
        </div>
      </div>
      <div class="drawer-scrim" id="scrim" hidden></div>
    </div>`;

  // Who you are, and the way to your own games -- reachable from the lobby rather than
  // only from the home screen, since a player waiting for opponents is exactly who has a
  // minute to look. The room id is remembered on the way out, so the profile can offer
  // the way back rather than stranding them on the home screen.
  const whoSlot = root.querySelector<HTMLElement>('#who')!;
  const paintWho = (): void => {
    const acc = getState().account;
    whoSlot.innerHTML = acc
      ? `<a class="room-me" href="#/profile" title="Your profile and games">
           ${avatarHtml(acc.username, 'sm')}
           <span class="room-me-name">${escapeHtml(acc.username)}</span>
         </a>`
      : `<a class="btn btn-sm btn-ghost" href="#/login">Log in</a>`;
  };
  paintWho();

  const shell = root.querySelector<HTMLElement>('.shell')!;
  const sideWrap = root.querySelector<HTMLElement>('#sidewrap')!;
  const phoneTop = root.querySelector<HTMLElement>('#phone-top')!;
  const scrim = root.querySelector<HTMLElement>('#scrim')!;

  const boardHost = root.querySelector<HTMLElement>('#board')!;
  const leftCol = root.querySelector<HTMLElement>('#left')!;
  const rosterStack = root.querySelector<HTMLElement>('#rosters')!;
  const liveRegion = root.querySelector<HTMLElement>('#live')!;
  const rightCol = root.querySelector<HTMLElement>('#right')!;
  const trayEl = root.querySelector<HTMLElement>('#tray')!;
  const controls = root.querySelector<HTMLElement>('#controls')!;
  const stage = root.querySelector<HTMLElement>('#stage')!;
  const veil = root.querySelector<HTMLElement>('#veil')!;
  const veilInner = root.querySelector<HTMLElement>('#veil-in')!;
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

  /**
   * The phone layout.
   *
   * A phone has room for the board and the clock and nothing else, so everything that is
   * read between moves rather than during one -- rosters, chat, the move list, stats, the
   * card table -- goes behind a drawer, and the clock moves out of the side column it
   * lives in on a desktop and sits above the board where it can still be seen.
   *
   * The breakpoint is matched in CSS as well, but the class is what the two agree on:
   * one source of truth for "is this a phone", set here and read there.
   */
  const phoneQuery = window.matchMedia('(max-width: 780px)');
  let onPhone = phoneQuery.matches;
  let drawerOpen = false;

  const setDrawer = (open: boolean): void => {
    drawerOpen = open && onPhone;
    shell.classList.toggle('drawer-open', drawerOpen);
    scrim.hidden = !drawerOpen;
    root.querySelector('#menu')!.setAttribute('aria-expanded', String(drawerOpen));
  };

  const applyLayout = (): void => {
    onPhone = phoneQuery.matches;
    shell.classList.toggle('is-phone', onPhone);
    if (!onPhone) setDrawer(false);

    // The clock is the one panel that has to stay on screen, so it changes parents rather
    // than being duplicated: one TimerRing, one countdown, wherever it is standing.
    const wanted = onPhone ? phoneTop : rightCol;
    if (timerPanel.parentElement !== wanted) wanted.prepend(timerPanel);

    /*
     * On a phone the clock's panel is the only thing above the board, and everything
     * that rode along with it was costing the board height it cannot spare -- a phone
     * report came in reading, fairly, "bad formatting on phone screen unplayable".
     *
     * So the three buttons that are about the game rather than the position go into the
     * drawer on a phone, where they are two taps away and cost nothing until they are
     * wanted. Moved rather than duplicated, for the same reason the clock is.
     */
    const actionsHome = onPhone
      ? root.querySelector<HTMLElement>('#drawer-actions')!
      : timerPanel;
    if (gameActions.parentElement !== actionsHome) actionsHome.appendChild(gameActions);

    // Sound and effects are preferences, not moves. On a phone they wrap the header onto
    // a second line, so they go in the drawer beside the way out.
    const prefsHome = onPhone
      ? root.querySelector<HTMLElement>('#drawer-prefs')!
      : root.querySelector<HTMLElement>('.topbar')!;
    for (const id of ['#sound', '#fx']) {
      const btn = root.querySelector<HTMLElement>(id)!;
      if (btn.parentElement !== prefsHome) prefsHome.appendChild(btn);
    }

    // Exit moves rather than being hidden and rebuilt: the header has no room for it on a
    // phone, and a way out of the room that only exists on a desktop is not a way out.
    const exitBtn = root.querySelector<HTMLElement>('#exit')!;
    const exitHome = onPhone
      ? root.querySelector<HTMLElement>('#drawer-exit')!
      : root.querySelector<HTMLElement>('.topbar')!;
    if (exitBtn.parentElement !== exitHome) exitHome.appendChild(exitBtn);

    sizeBoard();
  };

  const uiScale = (): number => {
    const v = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--ui'));
    return Number.isFinite(v) && v > 0 ? v : 1;
  };

  const heightOf = (el: HTMLElement | null): number =>
    el && !el.hidden ? el.getBoundingClientRect().height : 0;

  /**
   * Everything in the board's column that is not the board, gaps included.
   *
   * Measured off the column itself rather than added up from a list of its children,
   * which is what this did and what kept going wrong: every row added since -- the card
   * table, the constraint line -- had to be remembered here as well, and when one was
   * not, the column grew past the window and the whole desktop page began to scroll.
   * A subtraction cannot forget a child.
   */
  const besideBoard = (): number => {
    const col = stage.parentElement;
    if (!col) return 0;
    // The column's own height is no use here: it is a stretched grid item, so it is as
    // tall as the row whatever is in it. What is wanted is the height of its *contents*
    // other than the board, so the children are walked -- generically, so that a row
    // added later is counted without anyone having to remember this function exists.
    const kids = [...col.children].filter(
      (el): el is HTMLElement => el instanceof HTMLElement && !el.hidden);
    const shown = kids.filter(el => el.getBoundingClientRect().height > 0);
    const gap = parseFloat(getComputedStyle(col).rowGap) || 0;
    let total = shown.length > 1 ? gap * (shown.length - 1) : 0;
    for (const el of shown) if (el !== stage) total += el.getBoundingClientRect().height;
    return total;
  };

  const sizeBoard = (): void => {
    const ui = uiScale();
    const w = window.innerWidth;

    // On a phone the board takes the width it is given and the height is whatever the
    // clock, the hand and the button row leave -- all of which are measured, so adding a
    // row can never quietly push the board off the bottom.
    if (onPhone) {
      const pad = 20;
      const topbar = heightOf(root.querySelector<HTMLElement>('.topbar'));
      const availH = window.innerHeight - topbar - besideBoard() - pad * 2 - 24;
      const size = Math.max(240, Math.min(w - pad, availH));
      boardHost.style.setProperty('--board-size', `${Math.round(size)}px`);
      return;
    }

    const stacked = w <= 1180;   // the side columns drop under the board below this

    // width: the page padding and, on a wide screen, both side columns and the gaps
    const pagePad = 2 * 26 * ui;
    const columns = stacked ? 0 : (280 + 320 + 2 * 26) * ui;
    const availW = w - pagePad - columns - 8;

    // height: everything else in the board column, measured
    const topbar = heightOf(root.querySelector<HTMLElement>('.topbar'));
    const others = besideBoard();
    const measured = window.innerHeight - topbar - others - pagePad;
    // before the first paint the measurements are zero; fall back to a sane guess
    const availH = others > 0 ? measured : window.innerHeight - 260 * ui;

    // Two ceilings: never more than 84% of the window height, so the board is never the
    // only thing on screen, and a generous absolute cap that itself grows with the scale.
    const cap = Math.min(window.innerHeight * 0.84, 1040 * ui);

    // Floored rather than rounded, and two pixels short: every row in the column is
    // measured to a fraction and the board is the only one that can absorb the rounding.
    // Two pixels is the difference between a page that fits and a page with a scrollbar.
    const size = Math.max(300, Math.min(availW, availH, cap) - 2);
    boardHost.style.setProperty('--board-size', `${Math.floor(size)}px`);
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
      // A sacrifice, once paid for, is what the move is made with -- it beats any card
      // pick, because it is a bigger and more deliberate payment than one.
      // Otherwise: an explicit pick is honoured, and with none the server spends the
      // cheapest card that covers the piece, which is what the player would have chosen.
      const sacrificeIds = cardHand.sacrificeSelection() ?? undefined;
      const cardId = sacrificeIds ? undefined : (cardHand.selection() ?? undefined);
      armTurnReport();
      const ok = await net.sendMove({ from, to, promotion, cardId, sacrificeIds });
      if (ok) {
        cardHand.clearSelection();
      } else {
        pendingPly = null;
        if (sacrificeIds) toast('That sacrifice was refused', 'danger');
      }
      return ok;
    },
    onIllegal: () => sfx.illegal(),
    onPickup: () => { sfx.pickup(); tel.pickedUp(); },
    requestPromotion: promotionDialog,
    onPremove: move => {
      premove = move;
      if (move) {
        sfx.pickup();
        announce(`Move queued: ${move.from} to ${move.to}. It plays the moment `
          + 'your turn opens.');
      }
    },
    onMark: (square, to) => {
      const s = getState();
      if (!isSeated(s)) {
        toast('Only a seated player can mark squares');
        return;
      }
      // A mark points at the live position, and lives exactly one ply. Placed from a
      // reviewed board it would land on a square nobody else is looking at.
      if (isReviewing(s)) {
        toast('Marks belong to the live position — press Escape to come back');
        return;
      }
      net.toggleMark(square, to);
    },
  });

  /**
   * The move queued for a turn that has not arrived.
   *
   * Held here rather than in the store because it is not shared state and never survives
   * the room: it is one player's intention about the next few seconds.
   */
  let premove: { from: string; to: string } | null = null;
  let firingPremove = false;

  /**
   * Play the queued move the instant the turn opens.
   *
   * The server is still the judge. A premove is chosen against a position the opponent
   * was about to change, so it is often no longer legal -- and in cards mode the hand it
   * was chosen with may have been dealt into since. A refusal is therefore expected and
   * not an error: the move is simply dropped and the player told, with the turn still
   * theirs to use.
   */
  const firePremove = async (): Promise<void> => {
    const queued = premove;
    if (!queued || firingPremove) return;
    firingPremove = true;
    premove = null;
    board.clearPremove(false);

    const s = getState();
    const cardId = isCardsMode(s) ? (cardHand.selection() ?? undefined) : undefined;
    armTurnReport();
    const ok = await net.sendMove({ from: queued.from, to: queued.to, cardId });
    firingPremove = false;

    if (ok) {
      cardHand.clearSelection();
      tel.premovePlayed();
      return;
    }
    pendingPly = null;
    tel.premoveRejected();
    sfx.illegal();
    toast('Your queued move is no longer playable');
    announce('The queued move could not be played. It is still your turn.');
  };

  /**
   * The ply this player's move will become, held until the state that carries it arrives.
   *
   * A move's acknowledgement comes back before the broadcast that contains it, so reading
   * the ply number off the store at that moment names the position the move was made
   * *from* -- and the server, quite correctly, drops a report about a ply this seat did
   * not play. The count is therefore taken before the move and confirmed after: my move
   * is the ply after the position I moved from, and it is reported once the store agrees
   * that it exists.
   */
  let pendingPly: number | null = null;

  const armTurnReport = (): void => {
    const room = getState().room;
    pendingPly = room ? room.history.length + 1 : null;
  };

  const flushTurnReport = (s: AppState): void => {
    if (pendingPly == null || !s.room) return;
    const entry = s.room.history[pendingPly - 1];
    if (!entry) return;
    const ply = pendingPly;
    pendingPly = null;
    // Somebody else's move landed where mine was expected -- a takeback, a bot, the clock.
    // The turn it described is gone, so the report goes with it.
    if (entry.color !== s.you?.seat?.color) return;
    tel.turnPlayed(s.room.gameSeq, ply);
  };

  /**
   * "4 of 11 legal moves affordable", under the hand, on your turn only.
   *
   * The one measurement a player is shown while they are still playing, and it stops
   * there deliberately. A hand that says how constrained it is answers the question the
   * mode actually poses -- "I can see the move, can I play it?" -- while a hang rate or a
   * think time on screen would turn the game into a second game played against the HUD.
   *
   * Counted by the board, from the same rule the server records the ply with, so the line
   * and the archive cannot disagree.
   */
  const constraintEl = root.querySelector<HTMLElement>('#constraint')!;
  const paintConstraint = (s: AppState): void => {
    // Emptied rather than hidden: the line comes and goes with the turn, and a row that
    // disappears takes its height with it, which moved the board every time the turn
    // changed. Reported, fairly, as "the field size changes during the game".
    constraintEl.classList.toggle('constraint-cards', isCardsMode(s));
    if (!isCardsMode(s) || !isMyTurn(s) || !shownPosition(s).live) {
      constraintEl.textContent = '';
      return;
    }
    const { legal, affordable } = board.countAffordable();
    constraintEl.classList.toggle('constraint-tight', legal > 0 && affordable <= 2);
    constraintEl.textContent = legal === 0 ? '' : affordable === legal
      ? `Your hand covers all ${legal} legal moves`
      : `${affordable} of ${legal} legal moves your hand can pay for`;
  };

  const timer = new TimerRing();

  /**
   * Hovering a card previews its reach on the board without committing to it; clicking
   * narrows the board to that card until the move is made or the pick is dropped.
   */
  let hoverCardId: number | null = null;
  const applyReach = (): void => {
    const s = getState();
    if (!isCardsMode(s) || !isMyTurn(s)) { board.setAllowedTypes(null); return; }
    // While a sacrifice is being built the hand's own reach is beside the point: what the
    // board should show is what the sacrifice buys, and nothing until it is paid for.
    if (cardHand.sacrificeArmed()) { board.setAllowedTypes(cardHand.reach()); return; }
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
    onSelect: () => { applyReach(); sfx.click(); tel.cardPicked(); },
    onHover: id => { hoverCardId = id; applyReach(); },
    onSacrificeChange: () => { applyReach(); sfx.click(); },
    onMulligan: () => { unlockAudio(); net.mulligan(); },
    // one cue for the batch: five cards dealing in should sound like a deal, not five
    onDeal: () => { if (getState().soundOn) sfx.cardPlay(); },
  });
  cardsHost.appendChild(cardHand.el);

  const teamHandlers = {
    // No seat is named: the server picks the first free one, so two people pressing Join
    // at the same moment cannot both be told a seat they never chose was taken.
    onJoin: async (color: Color) => {
      unlockAudio();
      const res = await net.takeSeat(color);
      if (!res.ok) toast(res.error ?? 'Could not join that side', 'danger');
      else setState({ you: res.you ?? null });
    },
    onLeave: () => {
      net.leaveSeat();
      setState({ you: getState().you && { ...getState().you!, seat: null } });
    },
    onAddBot: (color: Color) => { unlockAudio(); net.setSeatBot(color, undefined, true); },
    onRemoveBot: (color: Color, seatId: number) => net.setSeatBot(color, seatId, false),
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
  // The move list is also the way back through the game, so the controls for that sit in
  // its own header rather than under the board -- the buttons and the plies they step
  // through belong together, and the board column has no room to spare.
  const movesPanel = panel('Move history', `
    <div class="review-bar" id="reviewbar">
      <button class="btn btn-sm btn-icon btn-ghost" id="rvfirst" title="First move (Home)">⏮</button>
      <button class="btn btn-sm btn-icon btn-ghost" id="rvprev" title="Previous move (←)">◀</button>
      <button class="btn btn-sm btn-icon btn-ghost" id="rvnext" title="Next move (→)">▶</button>
      <button class="btn btn-sm btn-icon btn-ghost" id="rvlast" title="Latest move (End)">⏭</button>
      <span class="review-at" id="rvat"></span>
      <button class="btn btn-sm" id="rvlive" title="Back to the live position (Esc)">Live</button>
    </div>
    <div class="moves" id="moves"></div>`);
  movesPanel.classList.add('panel-grow');
  const statsPanel = panel('Player stats', '<div class="panel-body" id="stats"></div>');
  const timerPanel = document.createElement('section');
  timerPanel.className = 'panel edge sheen panel-fire';
  timerPanel.appendChild(timer.el);

  /**
   * Resign, offer a draw, ask for a takeback, go back to the lobby.
   *
   * Under the clock rather than under the board, which is where a player asked for them:
   * they are about the game rather than about the position, they are never urgent, and
   * every pixel they took under the board was a pixel of board. What stays down there is
   * the one button that moves the game on -- Start, or Rematch.
   */
  const gameActions = document.createElement('div');
  gameActions.className = 'btn-row game-actions';
  timerPanel.appendChild(gameActions);

  /**
   * Friends, in the roster column: the panel that answers "who is here" is the one that
   * should answer "who could be". Guests get nothing -- a friend list belongs to an
   * account -- so it is only mounted for a signed-in player.
   */
  const friends = getState().account ? new FriendsPanel({ mode: 'invite' }) : null;

  net.onInvited(inv => showInvite(inv.fromName, inv.roomId, inv.mode));

  rosterStack.append(whitePanel.el, blackPanel.el);
  chat.el.classList.add('panel-grow');
  // In cards mode the chat goes (a team of one has no audience) and the table takes its
  // place, so the left column stays useful in both modes.
  // Under the rosters rather than inside them: the roster stack re-appends its two panels
  // whenever the board is flipped, which would push anything else in it to the bottom.
  leftCol.append(chat.el);
  if (friends) leftCol.append(friends.el);
  // Across the table from you: the opponent's cards go above the board, between the
  // captured tray and the board itself.
  boardHost.parentElement!.insertBefore(cardHand.infoEl, boardHost);
  rightCol.append(timerPanel, movesPanel, statsPanel);

  // Only now: `applyLayout` moves the clock between columns, so it cannot run until the
  // panel it moves exists. Calling it earlier reached `timerPanel` in its temporal dead
  // zone, and the ReferenceError took the whole room down with it -- an empty page with a
  // header, which is a far louder failure than the layout it was trying to arrange.
  applyLayout();
  phoneQuery.addEventListener('change', applyLayout);

  root.querySelector('#menu')!.addEventListener('click', () => {
    setDrawer(!drawerOpen);
    if (drawerOpen) tel.noteEvent('drawer');
    sfx.click();
  });
  root.querySelector('#drawer-close')!.addEventListener('click', () => setDrawer(false));
  scrim.addEventListener('click', () => setDrawer(false));

  let takebackHost: HTMLElement | null = null;
  let tbRaf = 0;
  /**
   * The game whose result has already been announced.
   *
   * A boolean could not survive a rematch. `onGameStart` cleared it and then `setState`
   * re-rendered synchronously -- while `s.room` was still the *previous*, finished game,
   * because the new `room:state` had not arrived yet -- so the old result card was shown
   * a second time, and the flag it set then swallowed the next game's result entirely.
   * Keying on the game itself makes both impossible: the stale render is for a game that
   * has been announced, and the next game has a number nothing has announced yet.
   */
  let gameOverShownFor: number | null = null;
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

    // The blood is not a sound setting, so it runs before the early return below: a
    // player with sound off still has to see what a sacrifice cost.
    if (fx.sacrifice) {
      // Whoever is on the clock now is *not* the player who paid -- the move has already
      // been applied by the time this arrives, so the payer is the other side.
      const payer: Color | null = s.room ? (s.room.turn === 'white' ? 'black' : 'white') : null;
      showBloodBurst(payer != null && s.you?.seat?.color === payer);
    }

    if (!s.soundOn) return;
    if (fx.sacrifice) sfx.resign();
    if (fx.auto) sfx.timeout();
    else if (fx.promotion) sfx.promote();
    else if (fx.castle) sfx.castle();
    else if (fx.captured) sfx.capture();
    else sfx.move();
    if (fx.check) setTimeout(() => sfx.check(), 130);
  });

  net.onGameStart(() => {
    myTurnAnnounced = false;
    tel.resetTelemetry();
    // a new game is not the old one's archive, and it is not being reviewed either
    setState({ archived: null, reviewPly: null });
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

  // Who you are in this room, refreshed with every broadcast rather than only when you
  // asked for it. See the server's `pushYou`: leaving a seat has no acknowledgement, so a
  // stale `you` is how a player and a bot ended up sharing a row in the roster.
  net.onYou(you => setState({ you }));

  /**
   * A hand does not outlive its game.
   *
   * The server sends a hand while a game is running and simply stops when one ends, so
   * the store went on holding the last one -- through Back to lobby, and into the next
   * room the player created, where a lobby with no deck cut still showed six cards. The
   * store is cleared the moment the room says it is not playing.
   */
  const forgetHandOffGame = (s: AppState): void => {
    const st = s.room?.status;
    if (s.hand && (st === 'lobby' || st == null)) setState({ hand: null });
  };

  // The game reached the archive: remember its id so the result card can offer the PGN.
  net.onArchived(g => setState({ archived: g }));

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

    // board -- the position on show, which is the live one unless a ply is being reviewed
    const shown = shownPosition(s);
    board.setOrientation(orientation(s));
    board.setPosition(shown.fen, shown.lastMove, shown.inCheck);
    board.setInteractive(canMoveNow(s),
      s.you?.seat ? (s.you.seat.color === 'white' ? 'w' : 'b') : null);
    boardHost.classList.toggle('board-reviewing', !shown.live);

    /*
     * The queued move goes first, before the board is told anything.
     *
     * `setPremoveEnabled(false)` clears whatever is queued -- which is right, because a
     * queue that outlives its turn is a move nobody asked for -- and the moment your turn
     * opens that is exactly what it does. It ran eighty lines above the code that fires
     * the queue, so by the time the room looked for a move to play there was never one
     * there. Premoves have not worked since; reported as exactly that.
     */
    if (isMyTurn(s) && shown.live && premove && !firingPremove) void firePremove();

    // Queueing a reply is offered while the opponent thinks: your seat, a live game, the
    // live position, and nothing else already waiting on you.
    const canQueue = shown.live
      && isSeated(s)
      && room.status === 'playing'
      && !isMyTurn(s)
      && !room.pendingTakeback
      && room.activeColor !== s.you?.seat?.color;
    board.setPremoveEnabled(canQueue);
    boardHost.classList.toggle('board-premove', canQueue);

    // marks describe the live position, so they come off a reviewed one
    board.setMarks(shown.live ? s.marks : []);

    // Cards mode narrows the board to what the hand can pay for; the team game never
    // restricts it, so the two share one board and one code path.
    const cardsMode = isCardsMode(s);
    if (cardsMode !== wasCardsMode) {
      wasCardsMode = cardsMode;
      root.querySelector('#mode-name')!.textContent = cardsMode ? 'Chess Cards' : 'Team Chess';
      sizeBoard();
    }

    // The hand belongs to a game in progress. Gating on "is there a hand in the store"
    // was not enough: the store keeps the last hand it was sent, so the cards were still
    // on screen after Back to lobby, and followed the player into the *next* room they
    // created. The room's own status is the only thing that actually knows.
    const inPlay = room.status === 'playing' || room.status === 'finished';
    const dealt = cardsMode && inPlay && (s.hand != null || room.cards != null);
    cardsHost.hidden = !dealt;
    cardHand.infoEl.hidden = !dealt;
    if (isCardsMode(s)) {
      cardHand.render(s.hand, room.cards, s.you?.seat?.color ?? null);
      applyReach();
      // Off turn the board is told what the hand *holds* rather than what it can play:
      // "if I have the necessary cards, let me queue the move".
      if (!isMyTurn(s)) board.setAllowedTypes(heldReach(s.hand));
      // Castling costs a Rook card here, so the board is told whether one can be paid --
      // otherwise it would offer a castle the server is about to refuse.
      board.setCastlingAllowed(s.hand?.canCastle !== false);
    } else {
      board.setAllowedTypes(null);
      board.setCastlingAllowed(true);
    }

    renderTray(trayEl, shown.fen);
    renderMoves(root.querySelector<HTMLElement>('#moves')!, room.history, {
      at: reviewAt(s),
      onPick: ply => { setReviewPly(ply); sfx.click(); },
    });
    renderReviewBar(s);
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
    forgetHandOffGame(s);
    flushTurnReport(s);
    paintConstraint(s);

    if (isMyTurn(s)) {
      if (!myTurnAnnounced) {
        myTurnAnnounced = true;
        // The turn has opened: hesitation is counted from here, not from the move.
        tel.turnOpened();
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

    if (room.status === 'finished' && gameOverShownFor !== room.gameSeq) {
      gameOverShownFor = room.gameSeq;
      showGameOver(room, isHost, s.archived?.id ?? null);
      announce(gameOverLine(room));
      if (s.soundOn) playEndgame(room, s.you?.seat?.color ?? null);
    }
    if (room.status !== lastStatus) { lastStatus = room.status; }

    // The board takes whatever the column has left, and what the column has left changes
    // with the state -- the hand appears when the game starts, the constraint line comes
    // and goes with the turn, the button row empties. Sizing only on resize meant the
    // board kept a height that was correct for a lobby and 148px too tall for a game,
    // and the desktop page scrolled: reported as "scroll on the full screen page
    // computer wrong". Measuring is cheap; guessing when to measure was the mistake.
    sizeBoard();
  }

  const reviewBar = root.querySelector<HTMLElement>('#reviewbar')!;
  const reviewAtEl = root.querySelector<HTMLElement>('#rvat')!;

  function renderReviewBar(s: AppState): void {
    const plies = s.room?.history.length ?? 0;
    reviewBar.hidden = plies === 0;
    if (plies === 0) return;

    const at = reviewAt(s);
    const live = !isReviewing(s);
    reviewBar.classList.toggle('reviewing', !live);
    reviewAtEl.textContent = live ? 'live'
      : at === 0 ? 'start' : `${Math.ceil(at / 2)}${at % 2 ? '.' : '…'}`;

    const dis = (id: string, off: boolean): void => {
      const b = root.querySelector<HTMLButtonElement>(id);
      if (b) b.disabled = off;
    };
    dis('#rvfirst', at === 0);
    dis('#rvprev', at === 0);
    dis('#rvnext', live);
    dis('#rvlast', live);
    dis('#rvlive', live);
  }

  const step = (to: number | null): void => {
    if (to != null && !isReviewing(getState())) tel.noteEvent('review');
    setReviewPly(to);
    sfx.click();
  };
  reviewBar.querySelector('#rvfirst')!.addEventListener('click', () => step(0));
  reviewBar.querySelector('#rvprev')!.addEventListener('click',
    () => step(reviewAt(getState()) - 1));
  reviewBar.querySelector('#rvnext')!.addEventListener('click',
    () => step(reviewAt(getState()) + 1));
  reviewBar.querySelector('#rvlast')!.addEventListener('click', () => step(null));
  reviewBar.querySelector('#rvlive')!.addEventListener('click', () => step(null));

  /**
   * Two rows, split by what they are for.
   *
   * `main` is the one thing the game is waiting on -- start it, play it again -- and sits
   * under the board where the eye already is. `manage` is everything about the game
   * rather than the position, and sits under the clock.
   */
  function renderControls(s: AppState, isHost: boolean): void {
    const room = s.room!;
    const main: string[] = [];
    const manage: string[] = [];

    if (room.status === 'lobby') {
      if (isHost) {
        const ready = room.white.seats.some(x => x.occupied)
          && room.black.seats.some(x => x.occupied);
        main.push(`<button class="btn btn-primary" id="start" ${ready ? '' : 'disabled'}>
          ${ready ? 'Start game' : 'Need a player on each team'}</button>`);
      } else {
        main.push(`<span style="color:var(--text-faint);font-size:13px;padding:9px 0">
          Waiting for the host to start…</span>`);
      }
    } else if (room.status === 'playing') {
      if (canRequestTakeback(s)) {
        manage.push(`<button class="btn btn-sm" id="tbreq">Request takeback</button>`);
      }
      // A team that is lost, or agreed on a draw, needs a way out that is not waiting for
      // mate. Both are open to any seated player, not just whoever is on the clock.
      if (canEndGame(s)) {
        manage.push(`<button class="btn btn-sm" id="drawoffer"
          ${canOfferDraw(s) ? '' : 'disabled'}>Offer draw</button>`);
        manage.push(`<button class="btn btn-sm btn-danger" id="resign">Resign</button>`);
      }
      if (isHost) {
        manage.push(`<button class="btn btn-sm btn-ghost" id="reset">Back to lobby</button>`);
      }
    } else if (room.status === 'finished' && isHost) {
      // Under the clock beside Back to lobby, where it was asked for: the two things you
      // do with a finished game belong together, and neither is about the position.
      manage.push(`<button class="btn btn-sm btn-primary" id="rematch">Rematch</button>`);
      manage.push(`<button class="btn btn-sm btn-ghost" id="reset">Back to lobby</button>`);
    }

    // In the lobby the main action is drawn over the board; in a game it sits under it.
    const inLobby = room.status === 'lobby';
    veil.hidden = !inLobby;
    veilInner.innerHTML = inLobby ? main.join('') : '';
    controls.innerHTML = inLobby ? '' : main.join('');
    controls.hidden = inLobby || main.length === 0;
    gameActions.innerHTML = manage.join('');
    gameActions.hidden = manage.length === 0;

    // Bound across both rows, because which row a button landed in is a question about
    // where it reads best, not about what it does.
    const find = (sel: string): HTMLElement | null =>
      controls.querySelector<HTMLElement>(sel)
      ?? veilInner.querySelector<HTMLElement>(sel)
      ?? gameActions.querySelector<HTMLElement>(sel);

    find('#start')?.addEventListener('click', () => net.startGame());
    find('#rematch')?.addEventListener('click', () => net.rematch());
    find('#reset')?.addEventListener('click', () => net.resetToLobby());
    find('#tbreq')?.addEventListener('click', () => {
      net.requestTakeback();
      toast('Takeback requested — waiting on your opponent');
    });
    find('#drawoffer')?.addEventListener('click', () => {
      net.offerDraw();
      toast('Draw offered — waiting on your opponent');
      sfx.click();
    });
    // Resigning ends the game for the whole team and cannot be undone, so it asks first.
    find('#resign')?.addEventListener('click', () => {
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

  /**
   * The buttons on the card a finished game puts up, two to a row.
   *
   * The rematch takes a row of its own because it is the one thing most people came back
   * for; the rest pair off. Which of them exist depends on who you are and whether the
   * game was long enough to be archived, so the odd one out is worked out here rather
   * than left to a CSS rule that can only count children it cannot tell apart.
   */
  function goButtons(isHost: boolean, gameId: string | null): string {
    const rest: string[] = [];
    if (gameId) rest.push('<button class="btn" id="goreport">Your report</button>');
    rest.push('<button class="btn" id="goreview">Review the game</button>');
    rest.push('<button class="btn btn-ghost" id="goclose">Close</button>');
    if (rest.length % 2 === 1) {
      rest[rest.length - 1] = rest[rest.length - 1].replace('class="btn', 'class="go-wide btn');
    }
    const lead = isHost
      ? '<button class="btn btn-primary go-wide" id="goagain">Rematch</button>' : '';
    return lead + rest.join('');
  }

  function showGameOver(room: RoomState, isHost: boolean, gameId: string | null): void {
    const w = room.gameOver?.winner;
    const title = w === 'draw' ? 'Draw'
      : w === 'white' ? 'White wins'
      : w === 'black' ? 'Black wins' : 'Game over';
    const { host, close } = modal(`
      <div class="go-crown">${w === 'draw' ? '½' : '♔'}</div>
      <div class="go-result">${title}</div>
      <div class="go-reason">${escapeHtml(reasonLabel(room))}</div>
      <div style="margin-top:20px" id="gostats"></div>
      ${gameId ? `<p class="go-saved">Saved to your profile — you can step back through it
        here, or <a href="${net.pgnUrl(gameId)}" target="_blank" rel="noopener">take the
        PGN</a>.</p>` : ''}
      <div class="go-actions">${goButtons(isHost, gameId)}</div>`);
    renderStats(host.querySelector<HTMLElement>('#gostats')!, room);
    host.querySelector('#goclose')!.addEventListener('click', close);
    host.querySelector('#goreview')!.addEventListener('click', () => { close(); step(0); });
    // The report needs the whole archived game -- the room only ever saw the summary --
    // so it is fetched on the way in rather than held against the chance it is wanted.
    host.querySelector('#goreport')?.addEventListener('click', async ev => {
      const btn = ev.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      const full = await net.fetchGame(gameId!);
      btn.disabled = false;
      if (!full) { toast('That game is not stored yet', 'danger'); return; }
      close();
      openGameViewer(full, { view: 'report', you: getState().you?.seat?.color ?? null });
    });
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

  // A bug is most reportable from the room it happened in, which is also the only place
  // the report can pick up the position and the game it happened in.
  root.querySelector('#bug')!.addEventListener('click', () => openBugReport());

  root.querySelector('#exit')!.addEventListener('click', onLeave);

  const onKey = (e: KeyboardEvent): void => {
    // Anywhere text is being typed, the room's single-key shortcuts are not shortcuts --
    // they are the letters. The bug report dialog is a *textarea*, which this guard used
    // to miss entirely: writing "the effects flicker" flipped the board, muted the sound
    // and toggled the effects on the way past, and the arrow keys, which are prevented
    // here, could not move the cursor through what had been typed.
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement
      || t instanceof HTMLTextAreaElement
      || (t instanceof HTMLElement && t.isContentEditable)) return;

    // A dialog over the room owns the keyboard while it is open, whatever has focus
    // inside it. Escape included: it is the dialog's way out, not the review's.
    if (document.querySelector('.modal-host')) return;

    // The board owns the arrows while it has focus -- they drive its own square cursor --
    // so stepping through the game is only bound outside it.
    const inBoard = e.target instanceof Node
      && boardHost.querySelector('.board-squares')?.contains(e.target) === true;
    if (!inBoard) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(reviewAt(getState()) - 1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); step(reviewAt(getState()) + 1); return; }
      if (e.key === 'Home') { e.preventDefault(); step(0); return; }
      if (e.key === 'End') { e.preventDefault(); step(null); return; }
    }
    if (e.key === 'Escape') {
      if (drawerOpen) { e.preventDefault(); setDrawer(false); return; }
      if (isReviewing(getState())) { e.preventDefault(); step(null); return; }
      if (premove) {
        e.preventDefault();
        premove = null;
        board.clearPremove(false);
        toast('Queued move cleared');
        return;
      }
    }

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

  // What this game is being played on. Sent once on entering the room, and again if the
  // window crosses into a different class of device -- turning a phone sideways is a
  // different layout, and the whole point of collecting it is to know whether that one
  // gets used.
  tel.describeClient();
  const stopDescribing = tel.redescribeOnResize();

  return () => {
    unsub();
    stopDescribing();
    friends?.destroy();
    clearBloodBurst();
    timer.destroy();
    cardHand.destroy();
    board.destroy();
    cancelAnimationFrame(tbRaf);
    cancelAnimationFrame(drawRaf);
    window.removeEventListener('resize', sizeBoard);
    phoneQuery.removeEventListener('change', applyLayout);
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
