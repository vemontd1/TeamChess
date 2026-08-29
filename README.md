# Bolotnoye Logovo

Two chess variants that both ask the same question — *can I play the move I can see?* —
and answer it in different currencies.

**Team Chess** shares one side between a **team**. Teammates take turns in order, and every
turn runs on a countdown. Let the clock hit zero and the server plays a **random legal
move** for you, then control passes on regardless.

**Chess Cards** is one against one. You may only move a piece type you hold a card for —
the king excepted, who is always free.

Play is online — one player creates a room, everyone else joins by link.

## Team Chess: how the rotation works

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

## Chess Cards

You hold a hand of three. Each card names a piece type, and you may only move a piece you
hold the card for; playing it spends it. **The king never needs a card**, so no hand can
lock you out of the game.

```
  hand                          board
  ┌──────┐ ┌──────┐ ┌──────┐    the knights and pawns will move
  │ PAWN │ │KNIGHT│ │ ROOK │    the rooks will not: nothing is open for them,
  └──────┘ └──────┘ └──────┘    so the Rook card is dead this turn
     live     live     dead
```

One fixed 36-card deck per side, the same for both players — no deckbuilding:

| Pawn | Knight | Bishop | Rook | Queen | Wild |
|---|---|---|---|---|---|
| 11 | 8 | 8 | 5 | 3 | 1 |

A **Wild** moves anything. One copy in thirty-six: a rare universal answer, not a normal
turn.

**The loop.** Draw back up to three at the start of your turn, play one card, make one
ordinary chess move. The spent card goes face up on your discard; when your deck runs out
the discard is reshuffled into a new one. You may hold up to **seven** — past that you stop
drawing, so a card kept back for a future threat is a card you are not replacing.

**Tempo.** A capture draws you an extra card at the end of the turn. Going forward widens
the hand that has to sustain going forward.

**Soft enrage.** From the twentieth ply both sides draw to four instead of three, so the
endgame stops hanging on a bad draw.

**A card cannot outlive its piece.** Trade off both knights and any Knight cards you are
holding are swapped for fresh ones at the start of your next turn — they go back to the
discard, so promoting a pawn to a knight makes them meaningful again. Being unable to move
the bishop you *have* is a position to solve; holding a card for a bishop that no longer
exists is just a smaller hand. Only extinction triggers this, never a piece that is merely
blocked.

**Nobody gets stuck.** Two safety nets, in the order they fire:

- **Mulligan** — once a game, at the start of your turn, throw the whole hand away and take
  a fresh one. You still owe a move.
- **Emergency move** — if no card in your hand can move *anything*, a red Emergency card
  appears in it. It moves any piece you like, and costs one card taken at random from the
  hand you could not use anyway.

So the absence of a card never mates you. Mate only ever comes out of the position.

**The numbers are not the design doc's.** Its suggested hand of five and four Wilds measured
far too loose — the cards were inert on a third of all turns — and the first playtest said
so. `docs/BALANCE.md` has the simulation, the table, and why the shipped hand is three with
a single Wild; `npm run balance` re-runs it.

**What your opponent can see.** The size of your hand, and every card you have spent, face
up. Never the hand itself — hands travel to one socket, not in the broadcast room state, so
there is nothing to read in the network tab either.

## Rules and options

| Setting | Effect |
|---|---|
| **Game mode** | Team Chess, or Chess Cards. Cards is always 1v1 and forces a single seat per side. |
| **Players per team** | 1–5 seats per side. Team mode only. |
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
npm run balance      # simulate Chess Cards games and measure how much the cards bite
npm run test:unit    # the card engine, no server needed

npm start            # in one shell
npm test             # in another: unit tests, then the socket suite
```

`test/integration.mjs` drives real socket clients through the whole game: rotation order,
turn enforcement, timeout auto-moves, rotation past a timed-out seat, takeback accept/decline
(including that a requester cannot self-approve), bot seats, both `skipEmptySeats` modes,
reconnect, checkmate detection, draw offers and resignations (including that a spectator can
do neither and that a side cannot accept its own draw), that the clock is published as a
duration rather than only as an epoch, and that team chat and ghost marks reach the sender's
own team and nobody else.

For Chess Cards it plays both sides of a real game for thirty-odd plies, choosing only moves
the hand can pay for, and asserts at every ply that the draw refilled to the right target,
that a king move spent nothing and any other move spent exactly one card, that a capture
drew its tempo card, that the hand never passed seven, and that the public count matches the
real hand. It also checks that a card-less move is refused, that a takeback puts the exact
hand back, that the clock's forced move is one the hand could have paid for, and that no
card identity appears anywhere in the broadcast state.

`test/cards.mjs` covers the engine directly, because the deck is shuffled and the paths that
only open on an unlucky hand — the emergency move, a deck running dry — would otherwise go
years without being exercised.

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
- In Chess Cards, hover a card to preview what it can move, click it to commit the board to
  it, or just move a piece and the matching card is spent for you — the exact card before a
  Wild, and a Wild before the emergency move. Pieces you cannot reach this turn are dimmed.
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

The override reaches the CSS as well as the fire canvas. The level is mirrored onto the
root element as `data-motion`, and the blanket reduced-motion rule in `theme.css` is scoped
to the absence of `data-motion="full"` — otherwise its `!important` would have outranked the
very toggle the room advertises, leaving **E** able to restore only the one effect that
happens to be drawn in JavaScript.

In Chess Cards this is the difference between the Wild shimmering and sitting still. Cards
dealing in and being spent are not affected by any of it: those are how you see the hand
change, and hiding them would not calm the interface, only make it lie.

## Sizing

The game is built for a desktop first: two rosters, a board, a clock, a move list and a
chat, all on screen at once and none of them scrolling past each other.

Everything scales from one variable. `--ui` in `theme.css` steps up at 1500, 1800, 2300 and
3000 pixels wide, and every font size in the app is multiplied by it, along with the fixed
dimensions that have to keep pace with type — the timer ring, the cards, the captured tray.
The board is sized in JavaScript from what the window actually has left: the height of
everything sharing its column is *measured* rather than guessed at, so adding a row under
the board can never quietly push it off the bottom of the screen again.

Above 1180px the shell is exactly one viewport tall and the side columns scroll inside
themselves, with the move list and the chat log taking up whatever the fixed panels leave.
The alternative — letting the tallest column push the document past the window — meant that
on a short screen, reaching for the chat scrolled the board out of view.

Below 1180px the columns stack under the board and the page scrolls normally.

| | 1366×768 | 1920×1080 | 2560×1440 | 3840×2160 |
|---|---|---|---|---|
| `--ui` | 1.0 | 1.16 | 1.28 | 1.45 |
| Board | 593 | 851 | 1193 | 1508 |

The landing screen stops scaling at 1.08. It is one tall column of form controls with a
fixed amount in it, so scaling it further only pushes the Create button below the fold.

## Layout

```
server/src/
  index.ts    Socket.IO event handlers, takeback resolution, team-scoped delivery
  room.ts     room model, rotation cursors, clocks, undo frames, chat, marks
  cards.ts    Chess Cards: deck, hands, spending, the emergency move, and TUNING
  bots.ts     move selection — 'random' for timeouts, 'greedy' for bot seats
  types.ts    wire types (mirrored into client/src/types.ts)

client/src/
  main.ts             hash router (#/ and #/r/:roomId)
  state/store.ts      app state + derived turn/takeback predicates
  net/socket.ts       typed socket wrapper, token persistence
  board/board.ts      DOM board, pointer drag, keyboard play, ARIA grid, marks
  board/pieces.ts     Staunton piece SVGs
  ui/                 home, room, roster, timer ring, chat, cards, widgets
  audio/sfx.ts        WebAudio playback over the sample pack, plus synthesized cues
  styles/             theme tokens, layout, board, panels, chat
```

Chat, marks and card hands are deliberately **not** part of `RoomState`: that object is
broadcast to everyone in the room, so anything private has to travel on its own per-socket
channel. `test/integration.mjs` asserts that the opposing side receives none of them.

## Credits

Sound effects: **JDSherbert — Tabletop Games SFX Pack**. `client/public/sfx/` holds the
renamed ogg/mp3 copies the app loads; the full source pack (`Assets/`, all formats) is kept
out of the repository. See `NOTICE.md` for the attribution terms.

The code is MIT licensed — see `LICENSE`. That license does not extend to the audio.
