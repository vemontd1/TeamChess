export type Color = 'white' | 'black';
export type Status = 'lobby' | 'playing' | 'finished';
export type SeatKind = 'human' | 'bot';

/**
 * `team` is the rotating-control team game. `cards` is Chess Cards: a strict 1v1 where a
 * player may only move a piece type they hold a card for, the king excepted.
 */
export type GameMode = 'team' | 'cards';

export interface RoomConfig {
  mode: GameMode;
  teamSize: number;            // 1..5, forced to 1 in cards mode
  skipEmptySeats: boolean;     // rotation only cycles occupied seats
  moveTimerSec: number | null; // per-move countdown, null = off
  allowTakeback: boolean;
}

// --- cards ---

export type CardKind = 'pawn' | 'knight' | 'bishop' | 'rook' | 'queen' | 'wild';

/** One card in your own hand, with whether it can actually move anything right now. */
export interface HandCard {
  id: number;
  kind: CardKind;
  playable: boolean;
}

/** What both players see of a side's cards: counts and a face-up discard, never a hand. */
export interface CardSidePublic {
  handCount: number;
  deckCount: number;
  discardCount: number;
  mulliganUsed: boolean;
  emergenciesUsed: number;
  played: CardKind[];
  sacrificesUsed: number;
  /** Plies until this side may sacrifice again; 0 means now. */
  sacrificeReadyIn: number;
  /**
   * How many cards this side may hold right now.
   *
   * Not a constant: it falls with the army, because a card is only worth holding while
   * you still own a piece it names. Public, because both players can count each other's
   * pieces anyway.
   */
  handCap: number;
}

export interface CardsPublic {
  white: CardSidePublic;
  black: CardSidePublic;
  /** Cards dealt at the start of a turn: two, or three once soft enrage is on. */
  drawPerTurn: number;
  handMax: number;
  sacrificeCost: number;
  enraged: boolean;
}

/**
 * Your own hand, delivered per-socket rather than in `RoomState` -- that object is
 * broadcast to the whole room, so a hand put in it would be readable in the opponent's
 * devtools, which in a game built on hidden information is the entire exploit.
 */
export interface HandState {
  color: Color;
  cards: HandCard[];
  /** True when no card in hand can move anything: the safety net is offered. */
  emergency: boolean;
  mulliganAvailable: boolean;
  yourTurn: boolean;
  /** Kinds cycled away this turn while looking for something that could move. */
  cycled: CardKind[];
  /**
   * Kinds swapped out at the start of this turn because that piece is gone from the
   * board. Reported so the swap can be explained rather than just happening.
   */
  replaced: CardKind[];
  /** Cards a sacrifice costs, and whether one can be paid out of this hand right now. */
  sacrificeCost: number;
  sacrificeAvailable: boolean;
  /** Plies until the sacrifice comes off cooldown; 0 when it is ready. */
  sacrificeReadyIn: number;
  /** The cap this hand is currently held to, which shrinks with the army. */
  handCap: number;
  /**
   * Whether a castle could be paid for out of this hand.
   *
   * Castling is the one king move that is not free -- the rook travels too, so it costs a
   * Rook card. The board needs to know, or it would offer a castle it is about to refuse.
   */
  canCastle: boolean;
}

export interface SeatStats {
  moves: number;          // moves this seat actually played
  autoMoves: number;      // moves forced by the clock running out
  botMoves: number;       // moves played by a bot occupying this seat
  thinkMsTotal: number;   // cumulative deliberation time
  captured: number;       // material points taken
}

export interface SeatView {
  id: number;
  name: string | null;
  kind: SeatKind;
  occupied: boolean;
  connected: boolean;
  stats: SeatStats;
}

export interface TeamView {
  color: Color;
  seats: SeatView[];
  activeSeatId: number | null;
}

export interface GameOver {
  reason: 'checkmate' | 'stalemate' | 'threefold' | 'fifty-move' | 'insufficient'
        | 'draw' | 'agreement' | 'resignation';
  winner: Color | 'draw' | null;
}

export interface HistoryEntry {
  ply: number;
  san: string;
  color: Color;
  seatId: number;
  playerName: string;
  auto: boolean;   // forced by timeout
  bot: boolean;    // played by a bot seat
  /**
   * The position this ply produced.
   *
   * Carried per ply rather than replayed from the SAN list on demand: a client stepping
   * back through the game then needs no chess engine and no replay loop, and an archived
   * game is reviewable exactly as it was even if the move generator ever changes under it.
   */
  fen: string;
  from: string;
  to: string;
}

export interface PendingTakeback {
  byColor: Color;       // team asking to take the move back
  byName: string;
  deadline: number;     // epoch ms when the request auto-declines
  remainingMs: number;  // the same window as a duration, immune to client clock skew
}

/** A draw offered by one team, awaiting the other team's active seat. */
export interface PendingDraw {
  byColor: Color;
  byName: string;
  deadline: number;     // epoch ms when the offer lapses
  remainingMs: number;  // time left on the offer, measured on the server's own clock
}

export interface RoomState {
  id: string;
  /**
   * Which game this is in this room, counting from one.
   *
   * A rematch resets everything else, so this is the only thing that tells two games
   * apart -- and "have I already announced this result?" has to mean *this* result.
   */
  gameSeq: number;
  status: Status;
  fen: string;
  turn: Color;
  white: TeamView;
  black: TeamView;
  activeColor: Color | null;
  activeSeatId: number | null;
  activePlayerName: string | null;
  turnDeadline: number | null;
  /**
   * Time left on the current turn, measured on the server's own clock at the instant this
   * snapshot was taken. `turnDeadline` alone is an absolute server epoch, and a client
   * whose clock is off by even a few seconds -- which is common, and was the case on the
   * deployed host -- subtracts it from its own `Date.now()` and gets a countdown that is
   * wrong or pinned at zero. A duration carries no clock in it, so it cannot skew.
   */
  turnRemainingMs: number | null;
  lastMove: { from: string; to: string } | null;
  lastMoveAuto: boolean;
  history: HistoryEntry[];
  inCheck: boolean;
  gameOver: GameOver | null;
  spectatorCount: number;
  pendingTakeback: PendingTakeback | null;
  pendingDraw: PendingDraw | null;
  /** Null in team mode. */
  cards: CardsPublic | null;
  config: RoomConfig;
}

// --- accounts ---

/** A registered player, as everyone else may see them. Never carries a hash or a salt. */
export interface Account {
  id: string;
  username: string;
  createdAt: number;
  /**
   * Set from the `ADMIN_USERS` environment variable, never from anything a client sends
   * and never stored on the account -- so admin is a property of the deployment rather
   * than of a row somebody might be able to edit.
   */
  isAdmin?: boolean;
}

export interface AuthResult {
  ok: boolean;
  error?: string;
  account?: Account;
  /**
   * The signed session the client stores. Separate from the seat token on purpose:
   * signing out must not cost you the seat you are sitting in, and reclaiming a seat
   * must not require being signed in.
   */
  session?: string;
}

export interface AuthPayload { username?: string; password?: string; }
export interface SessionPayload { session?: string; }

// --- the archive: finished games kept on disk ---

export type GameResult = 'white' | 'black' | 'draw' | 'unfinished';

/** Enough of a game to list it without opening the file it lives in. */
export interface GameSummary {
  id: string;
  roomId: string;
  mode: GameMode;
  /** The room's settings, so a listing can report what people actually play. */
  config?: RoomConfig;
  finishedAt: number;
  plies: number;
  white: string[];
  black: string[];
  result: GameResult;
  reason: string;
}

/**
 * A whole finished game. `history` carries a FEN per ply, so replaying this needs no move
 * generator at either end -- the archive is a record of positions, not of instructions
 * for reconstructing them.
 */
export interface ArchivedGame {
  id: string;
  finishedAt: number;
  /**
   * How the game measured. Absent on every game archived before metrics existed, which is
   * a permanent condition rather than a migration: readers treat it as optional.
   */
  metrics?: GameMetrics;
  roomId: string;
  config: RoomConfig;
  white: string[];
  black: string[];
  history: HistoryEntry[];
  startFen: string;
  finalFen: string;
  result: GameResult;
  reason: string;
}

// --- profiles ---

export interface ProfileRecord { wins: number; losses: number; draws: number; }

/**
 * A player, as thinly as a player can be recorded: a name, a tally, and the games behind
 * it. There is no account and no password -- the browser's own token is the identity, and
 * the id below is a hash of it, so a profile can be read from a URL without that URL
 * being the credential that reclaims the player's seats.
 */
export interface Profile {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  games: number;
  record: ProfileRecord;
}

/** One archived game as it looked from a particular player's side of the board. */
export interface ProfileGame extends GameSummary {
  yourColor: Color;
  yourResult: 'win' | 'loss' | 'draw';
  opponents: string[];
  /**
   * How that side measured, kept with the game rather than looked up from the archive.
   *
   * The profile is the one place a trend can be drawn -- think time over a season, a hang
   * rate that is or is not coming down -- and a trend cannot be built from a list of
   * results. Absent on games played before metrics existed, and on games where the
   * archive write failed, so every reader treats it as optional.
   */
  you?: SideMetrics;
}

export interface ProfileView {
  profile: Profile;
  games: ProfileGame[];
  /**
   * When each remembered game finished, newest last, for the activity grid.
   *
   * Timestamps rather than day keys, and that is the whole point: which day a game
   * belongs to is a question about the *player's* clock, not the server's. Counting days
   * server-side put a game played at nine in the evening in New York on the following
   * day, so the grid lit a square the player had not played on and left the one they had
   * dark. The bucketing therefore happens in the browser, where the timezone is known.
   *
   * Kept as its own list rather than read off `games`, because that list is capped and a
   * year of play would otherwise show a grid that quietly emptied from the left.
   */
  playedAt: number[];
}

// --- friends ---

/** A friend, or someone who has asked to be one, as the other person sees them. */
export interface FriendView {
  id: string;
  name: string;
  online: boolean;
  /** The room they are in, when they are in one -- what makes an invitation possible. */
  roomId: string | null;
}

export interface FriendsView {
  friends: FriendView[];
  /** People who have asked you. */
  incoming: FriendView[];
  /** People you have asked. */
  outgoing: FriendView[];
}

/** An invitation, delivered to a friend's live sockets and to nobody else. */
export interface FriendInvite {
  fromId: string;
  fromName: string;
  roomId: string;
  mode: GameMode;
  at: number;
}

// --- metrics ---

/**
 * The card state behind one ply. Chess Cards only.
 *
 * Never part of `RoomState`: every field here reconstructs a hand, and `RoomState` is
 * broadcast to the whole room including spectators. These reach a client only once the
 * game is over and there is nothing left to protect.
 */
// --- what only the client can see ---

/**
 * The browser, reported once per session.
 *
 * Advisory, all of it. A client can send whatever it likes here, so nothing that decides
 * a rule may read it -- it exists to answer questions the server cannot even ask, like
 * whether the phone layout is ever used and whether the people using it are the ones
 * timing out.
 */
export interface ClientInfo {
  device: 'phone' | 'tablet' | 'desktop';
  pointer: 'touch' | 'mouse' | 'pen';
  /** "390x844". */
  viewport: string;
  fx: 'full' | 'calm' | 'off';
}

/**
 * One turn, as the browser saw it.
 *
 * `pickups` and `cardSelections` are the interesting pair: they are hesitation, which the
 * server cannot see at all. A player who picks three pieces up and puts them all down is
 * having a different turn from one who moves instantly, and `thinkMs` reads the same for
 * both.
 */
export interface ClientPly {
  /** Pieces picked up and put down again before committing to a move. */
  pickups: number;
  /** Cards picked and unpicked before the move. */
  cardSelections: number;
  /** Turn opening to the first interaction with the board, against `thinkMs`. */
  timeToFirstTouchMs: number | null;
  /** Whether this move came out of the premove queue, and whether one was refused. */
  premove: 'none' | 'played' | 'rejected';
}

/** A side's turns as its browsers saw them, rolled up over the game. */
export interface ClientSideMetrics {
  /** Plies that carried a client report at all. Never more than `moves`. */
  plies: number;
  pickups: number;
  cardSelections: number;
  /** Median, in milliseconds, over the plies that reported one. */
  firstTouchMs: number;
  premovesPlayed: number;
  premovesRejected: number;
  /** Times the game was stepped back through, and the phone drawer opened. */
  reviewOpened: number;
  drawerOpened: number;
  /** Device classes seen on this side, by how many turns each played. */
  devices: Record<string, number>;
  pointers: Record<string, number>;
  fx: Record<string, number>;
}

export interface PlyCards {
  handSize: number;
  handCap: number;
  /** How many of each kind was held. Summed over a game, what the player actually saw. */
  handKinds: Record<string, number>;
  drawn: number;
  deadHeld: number;
  extinctHeld: number;
  replaced: number;
  cycled: number;
  payment: 'card' | 'sacrifice' | 'emergency' | 'free';
  spentKind: string | null;
  canCastle: boolean;
  deckLeft: number;
  discardLeft: number;
  sacrificeReadyIn: number;
}

/** One half-move, as measured. The row everything else is an aggregate of. */
export interface PlyMetric {
  ply: number;
  color: Color;
  seatId: number;
  bot: boolean;
  auto: boolean;

  // the choice set: what could have been played
  legalMoves: number;
  legalTypes: number;
  affordableMoves: number;
  affordableTypes: number;
  /** The cards did nothing: everything legal was affordable anyway. */
  openTurn: boolean;
  onlyKing: boolean;
  forced: boolean;
  inCheck: boolean;

  // the move actually made
  piece: string;
  captured: string | null;
  promotion: boolean;
  castle: boolean;
  /** Material from White's point of view, after the ply. */
  materialAfter: number;
  /** What this ply won, from the mover's point of view. */
  swing: number;
  /** The moved piece can be taken for more than it won. */
  hung: boolean;
  hungValue: number;
  /** Best capture the mover could have afforded this turn. */
  bestCapture: number;
  /** `bestCapture` minus what was taken: material left on the table. */
  missed: number;

  // clock and attention
  thinkMs: number;
  /** This seat's previous turn ending to this turn opening -- the rotation's real cost. */
  waitMs: number | null;
  clockRemainingMs: number | null;
  clockFraction: number | null;

  cards?: PlyCards;
  /** What the browser reported for this turn, if it reported anything. Advisory. */
  client?: ClientPly;
}

/** One side's game, rolled up from its plies. */
export interface SideMetrics {
  moves: number;
  autoMoves: number;
  botMoves: number;
  thinkMsMean: number;
  thinkMsP90: number;
  waitMsMean: number;
  waitMsMax: number;
  affordableRatioMean: number;
  openTurns: number;
  onlyKingTurns: number;
  forcedTurns: number;
  hangs: number;
  missedTotal: number;
  captures: number;
  checksGiven: number;
  cardsDrawn: number;
  cardsSpent: number;
  drawnKinds: Record<string, number>;
  spentKinds: Record<string, number>;
  deadHeldMean: number;
  atCapTurns: number;
  emergencies: number;
  sacrifices: number;
  cycles: number;
  replacements: number;
}

export interface GameMetrics {
  /** Bumped when the shape changes. Old games have no block at all; never invent one. */
  schema: number;
  plies: PlyMetric[];
  white: SideMetrics;
  black: SideMetrics;
  durationMs: number;
  firstCapturePly: number | null;
  firstCheckPly: number | null;
  leadChanges: number;
  maxLead: number;
  /** The winner was behind at some point. */
  comeback: boolean;
  /**
   * What the browsers reported, per side.
   *
   * Absent for a game where nobody reported anything -- an old game, a client with the
   * channel switched off, or a room played entirely by bots.
   */
  client?: { white: ClientSideMetrics; black: ClientSideMetrics };
}

// --- insights: the archive, rolled up ---

/**
 * A histogram, and the few numbers worth deriving from one.
 *
 * Distributions rather than averages, because an average think time of twelve seconds
 * hides both the player who moves instantly and the one who times out, and those are two
 * different problems. The buckets are fixed so that a rolling aggregate can keep counting
 * into them without holding a single sample.
 */
export interface Distribution {
  /** Upper bound of every bucket but the last, which is open-ended. */
  bounds: number[];
  counts: number[];
  n: number;
  mean: number;
  p50: number;
  p90: number;
  max: number;
  unit: 'ms' | 'plies';
}

export type Phase = 'early' | 'middle' | 'late';

/** The same mode-health numbers, split by where in the game they were measured. */
export interface PhaseInsights {
  phase: Phase;
  plies: number;
  openTurnRate: number;
  affordableRatio: number;
  emergencyRate: number;
  hangRate: number;
  autoRate: number;
}

/** One mode, across every measured game of it. Rates are per ply unless said otherwise. */
export interface ModeInsights {
  mode: GameMode;
  /** Games with a metrics block. Games archived before metrics existed are not here. */
  games: number;
  plies: number;
  openTurnRate: number;
  affordableRatio: number;
  onlyKingRate: number;
  forcedRate: number;
  checkRate: number;
  captureRate: number;
  hangRate: number;
  missedMean: number;
  /** The clock played it: a timeout, counted against moves. */
  autoRate: number;
  botRate: number;
  emergencyRate: number;
  sacrificesPerGame: number;
  deadHeldMean: number;
  atCapRate: number;
  cyclesPerGame: number;
  replacementsPerGame: number;
  /** Card kinds held, summed over every ply -- what players actually saw. */
  drawnKinds: Record<string, number>;
  spentKinds: Record<string, number>;
  results: Record<string, number>;
  reasons: Record<string, number>;
  /** Games that ended with everyone gone, as a share of measured games. */
  abandonRate: number;
  comebackRate: number;
  leadChangesMean: number;
  /**
   * The browser half, over the plies that reported one.
   *
   * Kept apart from everything above because it is a different kind of evidence: the
   * server measured the rest, and a client reported this. `clientPlies` is how much of
   * the mode it actually covers -- read a rate against `plies` and it will look like
   * nobody ever hesitated.
   */
  clientPlies: number;
  pickupsPerPly: number;
  cardSelectionsPerPly: number;
  premovesPlayed: number;
  premovesRejected: number;
  reviewOpens: number;
  drawerOpens: number;
  devices: Record<string, number>;
  pointers: Record<string, number>;
  fx: Record<string, number>;
  firstTouch: Distribution;
  phases: PhaseInsights[];
  think: Distribution;
  wait: Distribution;
  /** Plies per game. */
  length: Distribution;
  /** Time actually spent at the board, per game. */
  duration: Distribution;
}

/**
 * The room funnel: where people fall out before a game ever happens.
 *
 * Counted live, per room, each step at most once -- these cannot be recovered from the
 * archive, because a room that was never started leaves nothing behind. A rebuild
 * therefore keeps them rather than recomputing them.
 */
export interface FunnelInsights {
  created: number;
  seated: number;
  started: number;
  firstMove: number;
  finished: number;
  rematch: number;
}

/**
 * One declared target, and where we actually sit against it.
 *
 * A metric with no target is a number nobody can act on. `info` means the doc declares a
 * direction rather than a range; `unknown` means there is not yet enough play to say.
 */
export interface GuardrailRow {
  key: string;
  label: string;
  scope: GameMode | 'all';
  value: number | null;
  unit: 'pct' | 'ms' | 'ratio';
  min: number | null;
  max: number | null;
  /** The target as it should be printed, e.g. "10–20%". */
  target: string;
  status: 'good' | 'watch' | 'off' | 'info' | 'unknown';
  /** How many plies or games the value rests on. */
  samples: number;
  why: string;
}

export interface Insights {
  schema: number;
  updatedAt: number;
  /** Archived games folded in, and archived games that carried no metrics block. */
  gamesCovered: number;
  gamesUnmeasured: number;
  modes: ModeInsights[];
  daily: Array<{ day: string; games: number; plies: number }>;
  funnel: FunnelInsights;
  guardrails: GuardrailRow[];
}

// --- bug reports ---

/** What the client knew when a report was filed. Every field is optional by nature. */
export interface ReportContext {
  route: string | null;
  roomId: string | null;
  mode: GameMode | null;
  gameSeq: number | null;
  status: string | null;
  fen: string | null;
  plies: number | null;
  userAgent: string | null;
  viewport: string | null;
}

/**
 * A screenshot on a report.
 *
 * The bytes live on disk beside the report; only this record is carried in JSON. Both are
 * deleted when the report is resolved -- a screenshot is evidence for a bug, and once the
 * bug is fixed it is someone's screen that we have no further reason to hold.
 */
export interface ReportAttachment {
  id: string;
  name: string;
  mime: string;
  bytes: number;
}

export interface BugReport {
  id: string;
  at: number;
  text: string;
  /** Screenshots, deleted when the report is resolved. */
  attachments?: ReportAttachment[];
  /** The name the reporter was playing under; an account id when they had one. */
  reporter: string;
  accountId: string | null;
  context: ReportContext;
  resolved: boolean;
  resolvedAt?: number;
}

export interface ReportPayload {
  text?: string;
  context?: unknown;
  /** Images as data URLs, downscaled by the client before they are sent. */
  attachments?: Array<{ name?: string; dataUrl?: string }>;
}

// --- admin ---

/** Everything the admin panel shows, computed from the archive and the stores. */
export interface AdminOverview {
  games: {
    total: number;
    byMode: Record<string, number>;
    byResult: Record<string, number>;
    byReason: Record<string, number>;
    avgPlies: number;
    last7: number;
  };
  /** Room configurations, most used first. */
  setups: Array<{ label: string; count: number }>;
  accounts: number;
  profiles: number;
  reportsOpen: number;
  rooms: { live: number; playing: number };
  recent: GameSummary[];
}

export interface Seat { color: Color; seatId: number; }

export interface You {
  token: string;
  name: string;
  isHost: boolean;
  seat: Seat | null;
}

// --- socket event payloads ---
export interface CreatePayload { name: string; config: Partial<RoomConfig>; }
export interface JoinPayload {
  roomId: string; name: string; token?: string;
  /** A signed session, if the player is signed in. The account names them if so. */
  session?: string;
}
/**
 * `seatId` is optional on both: omitted (or negative) means "the first free seat on that
 * team", resolved by the server. The client used to pick the seat itself, which made
 * every join a small race -- two people pressing Join at the same moment both named seat
 * 1 and one of them got an error about a seat they never chose.
 */
export interface SeatTakePayload { color: Color; seatId?: number; }
export interface SeatBotPayload { color: Color; seatId?: number; bot: boolean; }
export interface MovePayload {
  from: string; to: string; promotion?: string;
  /** Cards mode: which card pays for this move. Omitted lets the server choose. */
  cardId?: number;
  /**
   * Cards mode: burn these cards instead, and move whatever you like. Takes precedence
   * over `cardId`, and is refused outright unless it names exactly the cost, in cards the
   * hand actually holds, off cooldown.
   */
  sacrificeIds?: number[];
}
export interface TakebackRespondPayload { accept: boolean; }
export interface DrawRespondPayload { accept: boolean; }
export interface JoinResult {
  ok: boolean;
  error?: string;
  you?: You;
  state?: RoomState;
}

// --- team coordination ---

/**
 * Chat and marks are team-scoped: a message reaches your own team only, spectators talk
 * among themselves, and neither ever crosses to the opposing team. That is enforced on
 * delivery rather than by filtering in the client -- otherwise the opposing team could
 * simply read the traffic in devtools, which in a game about coordinating a team would be
 * the whole exploit.
 */
export type ChatChannel = 'white' | 'black' | 'spectator';

export interface ChatMessage {
  id: number;
  channel: ChatChannel;
  name: string;
  text: string;
  at: number;
}

/** A square a teammate has flagged as interesting. Cleared whenever a ply is played. */
export interface MarkView {
  square: string;
  /**
   * The far end, when the mark is an arrow rather than a highlight.
   *
   * One shape rather than two: an arrow is a mark with somewhere to point, and giving it
   * its own event, its own store and its own lifetime would have been three copies of
   * something that already clears itself at the end of every ply.
   */
  to?: string;
  name: string;
  own: boolean;   // computed per recipient
}

export interface ChatSendPayload { text: string; }
export interface MarkTogglePayload { square: string; to?: string }

// --- client-only ---

/** Announced when a game ends by agreement rather than on the board. */
export type GameEnded =
  | { kind: 'resign'; byColor: Color; byName: string }
  | { kind: 'draw-agreed' };

export interface MoveFx {
  captured: boolean; castle: boolean; promotion: boolean; check: boolean; auto: boolean;
  /** Cards mode: this move was bought by burning a hand of cards. */
  sacrifice: boolean;
}
