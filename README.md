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

Each card names a piece type, and you may only move a piece you hold the card for; playing
it spends it. **An ordinary king move never needs a card**, so no hand can lock you out of
the game — castling is the exception, and is dealt with below.

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
| 14 | 8 | 7 | 4 | 2 | 1 |

Only four Rook cards, which is what gives castling a price worth thinking about.

A **Wild** moves anything. One copy in thirty-six: a rare universal answer, not a normal
turn.

**The loop.** You open on **one card for each piece kind** — Pawn, Knight, Bishop, Rook,
Queen — so no game starts stuck and the first turn offers you the whole board. After that
**two cards are dealt at the start of every turn**, and a move costs one, so a quiet turn
leaves you a card richer. The spent card goes face up on your discard; when your deck runs
out the discard is reshuffled into a new one. The hand caps at **seven**, and at the cap
the deal simply does not happen.

**Castling costs a Rook card.** It is the one king move that is not only a king move: the
rook crosses the board too, so it is paid for exactly as the rook move it contains would
be. Free castling quietly turned the king's exemption — which exists so that no hand can
lock you out — into the strongest thing you could do with an empty hand. With no Rook card
and no Wild the board will not offer it, and the hand panel says why.

**The hand shrinks with your army.** The cap is not a constant: it is two plus the number
of piece kinds you still have, floored at three. Five kinds gives the full seven, three
gives five, a lone pawn gives three. A card is only worth holding while you still own a
piece it names, and seven cards against a rook and three pawns is a pile with two useful
cards in it. **Nothing is ever taken from you** when the cap falls — the deal simply stops
until you have spent your way back under it.

**Tempo.** A capture draws you an extra card at the end of the turn. Going forward widens
the hand that has to sustain going forward.

**Soft enrage.** From the twentieth ply both sides are dealt three a turn instead of two,
so the endgame stops hanging on a bad draw.

**Sacrifice.** Once every ten plies you may burn **three cards** from your hand to move any
piece you like. This is the answer to the mode's sharpest moment — seeing the winning move
and holding the wrong cards for it. It costs most of a hand and two turns of dealing, and
the cooldown is what keeps it the way a game is rescued rather than the way it is played.
Pick **Sacrifice**, choose the three cards to burn, then move. Dead cards count as fuel,
which is often the point; the king is excluded, since he was free anyway.

**A card cannot outlive its piece.** Trade off both knights and any Knight cards you are
holding are swapped for fresh ones — they go back to the discard, so promoting a pawn to a
knight makes them meaningful again. Being unable to move the bishop you *have* is a
position to solve; holding a card for a bishop that no longer exists is just a smaller
hand. Only extinction triggers this, never a piece that is merely blocked.

The swap happens **the moment the piece dies**, on both sides, rather than when your own
turn next opens. That timing is the fix for a reported bug where a card appeared to arrive
and then change under you: the capture bonus dealt you a Knight card the instant you traded
your last knight, and taking *your* last knight left the dead cards sitting in your hand
until your turn came round. Both are closed — by the time a hand reaches anyone, it holds
no card for a piece that is not on the board.

**Nobody gets stuck.** Three safety nets, in the order they fire:

- **Cycling** — if nothing in your hand can move anything, dead cards are dealt past, one
  at a time, until something can. Free, automatic, and reported to you when it happens.
  Its only cost is the deck: the cards come back around later.
- **Mulligan** — once a game, at the start of your turn, throw the whole hand away and take
  a fresh opening hand of one card per piece kind. You still owe a move.
- **Emergency move** — for the one case cycling must not answer: **in check**, with a hand
  that can do nothing about it. A red Emergency card appears; it moves any piece you like,
  and costs one card taken at random from the hand you could not use anyway. It will also
  pay for a castle, since it reaches everything.

So the absence of a card never mates you. Mate only ever comes out of the position.

**The numbers have been tuned twice, in opposite directions.** The design doc's hand of
five with four Wilds measured far too loose; cutting to three with a single Wild measured
well and *played* thin. The shipped economy is the second correction — a bigger hand that
is dealt into rather than refilled — and it is a real loosening: the cards are inert on
about a quarter of turns rather than one in twenty. `docs/BALANCE.md` has both sweeps, what
the loosening cost, and the one constant (`handMax`) to change if it needs tightening.
`npm run balance` re-runs it.

**What your opponent can see.** The size of your hand, every card you have spent face up,
and how long until your sacrifice comes off cooldown. Never the hand itself — hands travel
to one socket, not in the broadcast room state, so there is nothing to read in the network
tab either.

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

## Stepping back through a game

Every ply the server records carries the position it produced, not just the move that made
it. Reviewing is therefore a seek rather than a replay: no move generator runs at either
end, and the position you are shown is the one that was played rather than a
reconstruction of it.

Click any move in the history to put that position on the board. The board turns gold and
says **reviewing**, and the arrow keys, `Home` and `End` step through the game; `Esc` or
the **Live** button comes back.

Reviewing is a lens, not a pause. **The clock keeps running and the game keeps going** —
looking back four moves cannot cost you the position you were about to play, and it cannot
cost your opponent anything either. While you are back there the board will not let you
move or mark a square, since neither would land where you are looking.

## Games are kept

A finished game is written to disk as JSON — one file per game, under `GAMES_DIR`
(default `data/games`). What is kept is the whole game: every ply with its position, the
final FEN, who played, and how it ended. A game abandoned in progress is kept too, and
scores nothing.

| endpoint | what it gives you |
|---|---|
| `GET /api/games?limit=N` | recent games, newest first |
| `GET /api/games/:id` | one whole game, ready to review |
| `GET /api/games/:id/pgn` | the same game as standard PGN |
| `GET /api/profile/:id` | one profile and its games |

The PGN is ordinary PGN, so a game can leave this app entirely and open in anything that
reads chess. The card mode's extras have no PGN representation; the ones that change how a
move came about — the clock playing it, a bot playing it — are written as comments rather
than dropped.

On a host with an ephemeral filesystem — a plain container, including Railway without a
volume attached — the archive survives restarts but not redeploys. Point `GAMES_DIR` at a
mounted volume to make it durable.

## Accounts and profiles

**A game record belongs to an account.** Register with a username and a password, and your
finished games follow you — to another browser, to your phone, through clearing your site
data. The first version of this hung the record on the browser token that reclaims your
seat after a refresh, which is storage rather than an identity: it could not survive a
cleared browser and could not follow anyone to a second device.

**Playing does not need one.** A guest can create a room, take a seat, play a full game
and have it archived like any other. What a guest does not get is the record, because
there is nothing to record it against — and inventing a per-browser identity to hang it on
is the thing that did not work. The panel on the home screen says exactly that rather than
implying the game is behind a sign-up.

Your profile holds a name, a win/draw/loss tally, and the games behind it — every one of
which opens in a replay you can step through.

### How it is kept

Passwords are hashed with **scrypt** and a per-account salt, compared in constant time,
and a sign-in attempt for a username that does not exist still pays for a hash — so the
reply cannot be used to work out who is registered. Sign-in is rate limited per socket.

A session is a signed token, `<accountId>.<issuedAt>.<HMAC-SHA256>`, carrying no
server-side state: nothing to store, nothing to look up, and a restart does not sign
everyone out. The trade is that an individual session cannot be revoked — rotating
`SESSION_SECRET` revokes all of them at once, which for a chess app is the right trade.
Sessions last a month.

The session and the seat token stay separate on purpose: **signing out must not stand you
up from the board you are sitting at**, and reclaiming a seat must not require being
signed in.

| variable | what it sets |
|---|---|
| `ACCOUNTS_DIR` | where accounts live (default `data/accounts`) |
| `SESSION_SECRET` | the key that signs sessions — set this in production |

Without `SESSION_SECRET` a key is generated and written beside the accounts, which is fine
locally and survives a restart; on a host with an ephemeral filesystem, set it, or every
redeploy signs everyone out.

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
the hand can pay for, and asserts at every ply that the opening hand held one card per piece
kind, that a turn deals what it says it deals, that a king move spent nothing and any other
move spent exactly one card, that a capture drew its tempo card, that the hand never passed
the cap, and that the public count matches the real hand. It also checks that a card-less
move is refused, that a takeback puts the exact hand back, that the clock's forced move is
one the hand could have paid for, and that no card identity appears anywhere in the
broadcast state. The sacrifice gets its own section: refused short of the price, refused
for a repeated card, refused inside its cooldown, and — when paid — burning exactly the
cards it named and no others.

The last two sections cover what a game leaves behind. Every recorded ply is replayed
through a real engine to prove its stored FEN is the position that ply actually produced,
which is what makes review work at all; and a game is played to a real checkmate to check
that it reaches the archive, comes back whole over HTTP, comes out as PGN, and lands on
both players' profiles as a win and a loss — under a profile id that is not the token
that would reclaim their seats.

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
- To **sacrifice**, press the button, click three cards to burn, then move any piece.
- Castling needs a Rook card (or a Wild); without one the board will not offer it.
- **←** / **→** step back and forward through the game, **Home** / **End** jump to either
  end, **Esc** returns to the live position. Clicking a move in the history does the same.
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

### If the fire is beside the clock rather than on it

That was a bug, and it is fixed. The ring is sized in CSS as `152px * var(--ui)`, so on a
large display it is drawn bigger than the 152-unit design grid — and the fire canvas was
pinned to a constant 244px box with a constant inset, which put it over the wrong circle
by roughly the amount `--ui` had grown. The canvas now measures the ring with a
`ResizeObserver` and applies the display scale as a single canvas transform, which keeps
the particle sizes, glow widths and bloom in proportion and tracks a window resize, a
scale step and a browser zoom alike.

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
