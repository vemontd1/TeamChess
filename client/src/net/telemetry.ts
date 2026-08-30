import { motionLevel } from '../state/motion';
import type { ClientInfo } from '../types';

/**
 * What only this browser can see.
 *
 * The server measures positions and clocks. It cannot see hesitation -- a piece picked up
 * and put back down, a card chosen and unchosen, the seconds before a hand moves at all --
 * and hesitation is the clearest signal there is that an interface is confusing. Nor can
 * it see what the game is being played *on*, which is the difference between "the phone
 * layout works" and "nobody has ever opened it".
 *
 * Three rules, all of them deliberate:
 *
 * - **Best-effort.** Nothing here is acknowledged and nothing here is retried. A dropped
 *   packet costs one row in an aggregate; a telemetry bug that could stall a move would
 *   cost the game. Every call is wrapped, so a failure here cannot escape into the caller.
 * - **Advisory.** A client can lie, so nothing that decides a rule may read any of it. The
 *   server clamps every number on arrival and treats the whole channel as a report rather
 *   than a fact.
 * - **Counters, not a stream.** One packet per turn, plus one for the session, plus a
 *   couple of events. This is not an event log and must never become one.
 */

type Sender = (event: string, payload: unknown) => void;

let send: Sender | null = null;
let described = false;

/** Counters for the turn in progress. Reset the moment a turn opens. */
let pickups = 0;
let cardSelections = 0;
let turnOpenedAt: number | null = null;
let firstTouchAt: number | null = null;
let premove: 'none' | 'played' | 'rejected' = 'none';

/** Wired once by the socket layer, so this module never imports it back. */
export function attachTelemetry(sender: Sender): void {
  send = sender;
}

function emit(event: string, payload: unknown): void {
  try { send?.(event, payload); } catch { /* never the caller's problem */ }
}

function deviceClass(): ClientInfo['device'] {
  const w = Math.min(window.innerWidth, window.innerHeight);
  if (w <= 520) return 'phone';
  if (w <= 900) return 'tablet';
  return 'desktop';
}

function pointerType(): ClientInfo['pointer'] {
  try {
    if (matchMedia('(pointer: coarse)').matches) return 'touch';
    if (matchMedia('(pointer: fine)').matches) return 'mouse';
  } catch { /* an older browser answers nothing, which is a mouse as far as this goes */ }
  return 'mouse';
}

/**
 * Describe the browser, once per session.
 *
 * Sent on entering a room rather than on connect, because a socket with no room behind it
 * has nothing to attribute this to. Re-sent after a resize crosses a class boundary --
 * turning a phone sideways is a different device as far as the layout is concerned.
 */
export function describeClient(): void {
  const info: ClientInfo = {
    device: deviceClass(),
    pointer: pointerType(),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    fx: motionLevel(),
  };
  described = true;
  emit('telemetry:client', info);
}

export function redescribeOnResize(): () => void {
  let last = deviceClass();
  const onResize = (): void => {
    const now = deviceClass();
    if (!described || now === last) return;
    last = now;
    describeClient();
  };
  window.addEventListener('resize', onResize);
  return () => window.removeEventListener('resize', onResize);
}

/** A turn has opened for this player: everything counted from here belongs to it. */
export function turnOpened(): void {
  pickups = 0;
  cardSelections = 0;
  premove = 'none';
  firstTouchAt = null;
  turnOpenedAt = Date.now();
}

/** Any first contact with the board or the hand, for the gap against think time. */
function touched(): void {
  if (firstTouchAt == null && turnOpenedAt != null) firstTouchAt = Date.now();
}

/** A piece lifted. Only the ones that go back down end up counting as hesitation. */
export function pickedUp(): void {
  touched();
  pickups++;
}

export function cardPicked(): void {
  touched();
  cardSelections++;
}

export function premovePlayed(): void { premove = 'played'; }
export function premoveRejected(): void { premove = 'rejected'; }

/**
 * The turn is over: report it.
 *
 * `pickups` is decremented by the one that became the move, so what is left is the count
 * of pieces picked up and put back -- which is the number that means anything.
 */
export function turnPlayed(gameSeq: number, ply: number): void {
  if (turnOpenedAt == null && premove === 'none') return;
  emit('telemetry:turn', {
    gameSeq,
    ply,
    pickups: Math.max(0, pickups - 1),
    cardSelections: Math.max(0, cardSelections - 1),
    timeToFirstTouchMs: firstTouchAt != null && turnOpenedAt != null
      ? firstTouchAt - turnOpenedAt
      : null,
    premove,
  });
  turnOpenedAt = null;
  pickups = 0;
  cardSelections = 0;
  premove = 'none';
}

/**
 * Something that belongs to the session rather than to a turn.
 *
 * Rate-limited here as well as on the server: stepping through a game move by move is one
 * player looking at one game, not forty of anything.
 */
const lastEvent: Record<string, number> = {};
export function noteEvent(kind: 'review' | 'drawer'): void {
  const now = Date.now();
  if (now - (lastEvent[kind] ?? 0) < 30_000) return;
  lastEvent[kind] = now;
  emit('telemetry:event', { kind });
}

/** Between games: the counters belong to a turn, and there is no turn. */
export function resetTelemetry(): void {
  pickups = 0;
  cardSelections = 0;
  turnOpenedAt = null;
  firstTouchAt = null;
  premove = 'none';
}
