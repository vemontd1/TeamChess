# Bolotnoye Logovo

Team chess with rotating control. Each side is a **team**; teammates take turns in order,
and every turn runs on a countdown. Let the clock hit zero and the server plays a **random
legal move** for you, then control passes on regardless.

Play is online — one player creates a room, everyone else joins by link.

## How the rotation works

Each team keeps its own pointer into its roster. White plays `A1`, Black plays `B1`,
White plays `A2`, Black plays `B2`, and so on, each team wrapping independently:

```
White roster        Black roster
  1. Anna    ◀────┐    1. Dmitri  ◀────┐
  2. Boris        │    2. Elena        │
  3. Clara ───────┘    3. Fyodor ──────┘

turn order:  Anna → Dmitri → Boris → Elena → Clara → Fyodor → Anna → …
```

Only the currently active seat can touch the board. Everyone else watches their teammate's
clock run down.

## Rules and options

| Setting | Effect |
|---|---|
| **Players per team** | 1–5 seats per side. |
| **Seconds per move** | Fresh countdown every turn (not a cumulative chess clock). At zero the server plays a uniformly random legal move, flags it in the history, and advances the rotation — and everyone hears it blow up. |
| **Skip empty seats** | On: the rotation closes over occupied seats only. Off: every seat keeps its slot, and an empty one resolves on the clock. |
| **Takebacks** | The team that just moved may ask; the **opposing** active player accepts or declines. Accepting rewinds the board *and* both rotation pointers. Declining resumes the banked clock remainder, so asking cannot buy thinking time. |

A game does not have to be played to mate. Any seated player can **offer a draw** or
**resign**, at any point in a live game and whether or not they are the one on the clock —
a teammate watching a hopeless position through three other turns is exactly who needs it.
A draw offer goes to the opposing team's active seat and lapses after twenty seconds;
unlike a takeback it does not touch the clock, so it cannot be used to stop thinking.
Resigning ends the game for the whole team, so it asks for confirmation first.

Any seat can be switched to a **bot** by the host, which plays a weak one-ply greedy move —
useful for uneven teams or for testing. Bots count as occupied seats.

The server is authoritative for every rule: move legality, whose turn it is, the clock, and
game end. A client that sends a move out of turn is simply refused.

The clock is published as a **duration**, not only as a deadline. A snapshot carries both
`turnDeadline` (the server's own epoch) and `turnRemainingMs`, and the client counts down
the duration against its own clock. Subtracting a server epoch from a local `Date.now()` is
correct exactly as long as the two machines agree about the time, and they do not: the
deployed host ran half a minute behind a player's PC, which pinned every 30-second
countdown at zero for the whole game. A duration has no clock inside it to disagree with.

## Running it

```bash
npm install
npm run dev          # server :3001, client :5173 (Vite proxies the socket)
```

Open http://localhost:5173, create a room, and share the invite link (the room code in the
top bar copies it). Someone arriving on the link is asked for a name before they enter, since
they never saw the home screen where that field lives; anyone who has played before already
has one stored and goes straight in. Each player needs their own browser profile — the seat
is held by a token in `localStorage`, so two tabs in the same profile share one seat.

### Production

```bash
npm run build        # client -> client/dist
npm start            # serves the built client and the WebSocket on one port
```

`PORT` is read from the environment (default 3001). `railway.json` is set up for a Railway
deploy; the same build/start pair works on any Node host.

### Tests

```bash
npm start            # in one shell
npm test             # in another
```

`test/integration.mjs` drives real socket clients through the whole game: rotation order,
turn enforcement, timeout auto-moves, rotation past a timed-out seat, takeback accept/decline
(including that a requester cannot self-approve), bot seats, both `skipEmptySeats` modes,
reconnect, checkmate detection, draw offers and resignations (including that a spectator can
do neither and that a side cannot accept its own draw), that the clock is published as a
duration rather than only as an epoch, and that team chat and ghost marks reach the sender's
own team and nobody else.

## Coordinating with your team

A team game needs a way to talk, and a rotation means most of the time you are watching
rather than moving. Two things fill that gap, and both are **team-scoped**: the opposing
team never receives them at all — the server decides who each message reaches, rather than
sending everything to everyone and asking the client to hide it.

- **Team chat**, in the left column, with five one-tap phrases for when there is no time to
  type. Seated players talk to their own team; spectators have their own channel.
- **Ghost marks** — **right-click** a square (or press **X** on it) to flag it for your
  teammates. They appear as violet dashed squares initialled with who marked them, and they
  clear the moment a ply is played, because a suggestion only means anything in the position
  it was made in. Only seated players can mark; six squares each.

## Controls

- **Drag** a piece, or **click** it and click a destination.
- **Offer draw** and **Resign** sit under the board while you hold a seat.
- **F** — flip the board. **M** — mute. **E** — visual effects on/off.
- **C** — jump to the chat box. **B** — jump back to the board.
- The board only glows and accepts input when it is genuinely your turn.
- When control reaches you, the screen blooms amber, the board pulses and a chime
  sounds — you can look away during a teammate's turn and still be called back.
- Victory, defeat and draw each have their own sound, and which one you hear depends on
  your own result rather than the board's.

### Playing without a mouse

The board is a real ARIA grid, so it can be played entirely from the keyboard and read by a
screen reader.

| Key | Does |
|---|---|
| **Tab** | Move focus to the board (the cursor appears) |
| **Arrows** | Move the cursor a square |
| **Home** / **End** | Jump to the a- or h-file on the current rank |
| **Enter** / **Space** | Select the piece under the cursor, or play the move to it |
| **Esc** | Drop the selection |
| **X** | Mark the square under the cursor for your team |

Every square announces what is on it, whether it is a legal target, whether it is marked,
and whether the king there is in check. Moves, turn handoffs, takebacks and the result are
announced as they happen.

### If the timer fire does not appear

Visual effects follow your OS "reduced motion" setting. On Windows that is
**Settings → Accessibility → Visual effects → Animation effects**, which many people turn
off for performance — with it off, browsers report `prefers-reduced-motion: reduce` and the
fire stays disabled. Press **E** (or the ✦ button) to override it for this app; the choice
is remembered.

## Layout

```
server/src/
  index.ts    Socket.IO event handlers, takeback resolution, team-scoped delivery
  room.ts     room model, rotation cursors, clocks, undo frames, chat, marks
  bots.ts     move selection — 'random' for timeouts, 'greedy' for bot seats
  types.ts    wire types (mirrored into client/src/types.ts)

client/src/
  main.ts             hash router (#/ and #/r/:roomId)
  state/store.ts      app state + derived turn/takeback predicates
  net/socket.ts       typed socket wrapper, token persistence
  board/board.ts      DOM board, pointer drag, keyboard play, ARIA grid, marks
  board/pieces.ts     Staunton piece SVGs
  ui/                 home, room, roster, timer ring, chat, widgets
  audio/sfx.ts        WebAudio playback over the sample pack, plus synthesized cues
  styles/             theme tokens, layout, board, panels, chat
```

Chat and marks are deliberately **not** part of `RoomState`: that object is broadcast to
everyone in the room, so anything team-private has to travel on its own per-socket channel.
`test/integration.mjs` asserts that the opposing team receives neither.

## Credits

Sound effects: **JDSherbert — Tabletop Games SFX Pack**. `client/public/sfx/` holds the
renamed ogg/mp3 copies the app loads; the full source pack (`Assets/`, all formats) is kept
out of the repository. See `NOTICE.md` for the attribution terms.

The code is MIT licensed — see `LICENSE`. That license does not extend to the audio.
