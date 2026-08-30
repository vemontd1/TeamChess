# Metrics — what to measure, and why

**Steps 1 and 2 are built** — per-ply recording, the archive block, and the shared module
that `test/balance.mjs` now computes through. Steps 3 to 6 are still a plan. Section 9 says
which is which.

## What it has to be for

Metrics that are not attached to a decision become a dashboard nobody reads. Every number
below exists to serve one of four questions:

1. **Is the mode healthy?** Chess Cards was tuned against a *simulation* —
   `test/balance.mjs` plays random affordable moves and reports how much the cards bite. We
   have never measured the same thing in real play, and the two will differ: a person
   steers toward positions their hand suits, which the harness cannot do. Every balance
   number we tune against should have a real-play twin.
2. **Where does a game go wrong?** Abandonment, timeouts, one-sided blowouts, the ply at
   which people stop.
3. **What should a player be told?** A post-game report is only possible if the game was
   instrumented while it was played.
4. **What will a future mode need?** A new mode should inherit the whole pipeline and
   declare only what is peculiar to it.

## The one rule: hidden information

`RoomState.history` is broadcast to everyone in the room, spectators included. **Any
per-ply metric that touches a hand cannot live there.** Hand size, kinds held, cards drawn,
affordable-move counts — all of it reconstructs the opponent's hand, which is the entire
mode.

So per-ply metrics live in a **parallel server-side array on the `Room`**, never in
`RoomState`, and are attached to the archive when the game ends. Once a game is finished
there is nothing left to protect and the full record can be served.

This is a hard constraint, not a preference. It is the easiest way to ship an exploit while
believing you shipped a dashboard.

## What is already recorded

| where | fields |
|---|---|
| `HistoryEntry` | `ply, san, color, seatId, playerName, auto, bot, fen, from, to` |
| `SeatStats` | `moves, autoMoves, botMoves, thinkMsTotal, captured` |
| `ArchivedGame` | `config, white, black, history, startFen, finalFen, result, reason, finishedAt` |
| profiles | `record{wins,losses,draws}`, `days{}` (per-day counts) |
| reports | free text plus room/mode/status/fen/plies/viewport/userAgent |

That is enough to replay a game and count results. It cannot answer a single balance
question, because nothing about the *hand* or the *choice set* survives the ply.

---

## 1. Per ply — the core record

One row per half-move, server-computed, written as the ply is applied. This is where most
of the value is; everything else is an aggregate of it.

### Position and choice set

| field | meaning |
|---|---|
| `legalMoves` | legal moves available to the mover |
| `legalTypes` | distinct piece kinds with a legal move |
| `affordableMoves` | of those, how many the hand could pay for |
| `affordableTypes` | distinct kinds the hand could reach |
| `openTurn` | `affordableMoves === legalMoves` — the cards did nothing |
| `onlyKing` | the only affordable move was a king move |
| `forced` | exactly one affordable move existed |
| `inCheck` | was the mover in check |

`affordableMoves / legalMoves` is the real-play twin of the harness's `moves`, and
`openTurn` of its `open`. **These two are the headline numbers for mode health.**

### The move actually made

| field | meaning |
|---|---|
| `piece`, `captured`, `promotion`, `castle` | shape of the move |
| `materialAfter` | material balance from White's view, after the ply |
| `swing` | change in `materialAfter` caused by this ply |
| `hung` | the moved piece can be taken next ply for more than it won |
| `hungValue` | how much is hanging |
| `bestCapture` | best capture the mover could have afforded this turn |
| `missed` | `bestCapture` minus what was taken — material left on the table |

Both are material only, and deliberately so. Reusing the bot's scorer was the first plan,
but it carries a random tiebreak — noise in a number that gets stored forever — and the
material terms need no move generation beyond the one `hung` already does. `hung` is
one ply: it does not search the recapture, so a defended piece reads as hanging when it is
merely traded. The point is the *rate* across thousands of plies, never the verdict on any
single move, and anything shown to a player has to say so.

### Clock and attention

| field | meaning |
|---|---|
| `thinkMs` | turn open to move made |
| `clockRemainingMs`, `clockFraction` | how much of the clock was left |
| `waitMs` | **wait time** — this seat's previous turn ending to this turn opening |
| `auto` | the clock played it |

`waitMs` is the one nobody thinks to record and the one that decides whether the team mode
is fun. In a 5v5 on a 30-second clock a player waits four turns to move once; if that
number is bad, the mode is bad, and no result table will ever say so.

### Cards (Chess Cards only — a mode extension)

| field | meaning |
|---|---|
| `handSize`, `handCap` | before the move |
| `handKinds` | `{pawn:2, rook:1, …}` — **quantity of card types held** |
| `drawn`, `drawnKinds` | dealt at turn start |
| `spentKind` | what paid for the move |
| `deadHeld` | cards in hand that could move nothing |
| `extinctHeld` | cards for pieces no longer on the board |
| `replaced`, `cycled` | swap and cycle counts this turn |
| `payment` | `card` / `sacrifice` / `emergency` / `free` |
| `canCastle` | could the hand have paid for a castle |
| `deckLeft`, `discardLeft` | pile sizes |
| `sacrificeReadyIn` | plies until the sacrifice returns |

Summing `handKinds` and `drawnKinds` across a game answers *"overall quantity of card types
per piece"* directly, and — more usefully — shows the **gap between what the deck contains
and what a player actually saw**, which reshuffles distort.

---

## 2. Per player-turn, per game, per room

**Per game, per side** (rolled up from plies): move count, mean/median/p90 `thinkMs`, mean
and max `waitMs`, timeouts, hang rate, mean `missed`, mean affordable ratio, cards drawn
and spent by kind, sacrifices, emergencies, mulligan used, cycles, takebacks asked and
granted, draw offers, chat lines, marks placed.

**Per game**: plies, wall-clock duration, result, reason, decisive vs drawn, lead changes,
largest lead, whether the winner was ever behind (comeback), the material trajectory, and
phase boundaries — first capture, first check, the ply a piece kind went extinct.

**Per room / session** — the funnel, which is where abandonment hides:

`created → both sides seated → started → first move → finished → rematch`

with the drop-off at each step, time from creation to start, and time spent waiting for a
second player. A mode that is never *started* is failing earlier than any in-game metric
can see.

**Per player** (profile aggregates): games by mode, win rate by colour, mean think time,
timeout rate, hang rate over time, rematch rate, retention (days played and streaks, both
already collected), and the same split by device class.

---

## 3. What only the client can see

The server sees positions and clocks. It cannot see hesitation, and hesitation is the
clearest signal that an interface is confusing.

| field | why |
|---|---|
| `pickups` | pieces picked up and put down before committing — indecision |
| `cardSelections` | cards clicked and unclicked before moving |
| `timeToFirstTouch` | turn open to first interaction, against `thinkMs` |
| `premoveQueued` / `premovePlayed` / `premoveRejected` | is the feature working |
| `reviewOpened` | did they step back through the game |
| `drawerOpened` | phone: are the hidden panels ever wanted |
| `deviceClass`, `viewport`, `pointerType` | phone vs desktop, touch vs mouse |
| `fxLevel` | motion setting, for effects decisions |

These arrive over a small, rate-limited, **best-effort** socket channel — a dropped
telemetry packet must never affect a game. They are advisory: a client can lie, so nothing
that decides a rule may depend on them.

---

## 4. Storage

- `PlyMetric[]` on the `Room`, server-side only, written in `applyMove`.
- Attached to `ArchivedGame` as `metrics: { schema, plies, perSide, perGame }` at game end.
- `schema: number` on every archived game. Old games lack the block; readers must treat it
  as optional forever rather than backfilling fiction.
- Size: **measured at ~790 bytes per ply**, so a 60-ply game archives at ~46 KB of metrics
  on top of ~6 KB of history. My estimate before building it was 5–8 KB per game and it was
  wrong by six times — repeated JSON keys, not the numbers. At 500 MB of volume that is
  still ~9,000 games, so it is affordable rather than free. If it ever stops being
  affordable the fix is short keys or a columnar layout, not less measurement.
- A rolling aggregate (`data/insights.json`) updated on each archive, so the admin panel
  never scans the archive. Rebuildable from the archive, so it is a cache and not a source.

## 5. One definition, two consumers

The most valuable structural change: put the metric computation in **one module that both
the live server and `test/balance.mjs` call**.

Today the harness keeps private copies of `open`, `moveCov` and `typeCov`. If real play and
simulation compute them even slightly differently then comparing them is worthless — and
comparing them is the entire reason to collect them. A shared `computePlyMetrics(chess,
side, …)` makes the harness a *predictor* of production rather than a second opinion.

## 6. What players get

- **Game report** on the review screen: your think time against theirs, how constrained
  your hand actually was, cards drawn against cards spent by kind, the moves where material
  was left hanging, the material graph.
- **Profile trends**: hang rate and think time over time, win rate per mode, favourite
  setups.
- **In game, sparingly.** A constraint line ("4 of 11 legal moves affordable") is honest and
  useful; more than that becomes a second game played against the HUD. The board already
  dims unreachable pieces, which is the same information shown better.

## 7. What the admin gets

Distributions, not averages — a mean think time of 12s hides both the instant movers and
the timeouts. Percentiles (p50/p90) for think time, wait time and game length.

Mode health per mode and per config: open rate, affordable ratio, emergency rate, sacrifice
rate, timeout rate, abandonment rate, rematch rate — split by early, middle and late phase,
because the endgame behaves differently and that is where the hand cap shrinks.

## 8. Guardrails

Metrics are worth more with a declared target. Starting points, to be argued with:

| metric | target | why |
|---|---|---|
| `openTurn` rate | 10–20% | above this the cards are decorative |
| emergency rate | < 3% | the design doc calls it insurance, not a normal turn |
| sacrifice rate | 1 per 2–3 games | a rescue, not a tax |
| timeout rate | < 5% of moves | otherwise the clock is playing the game |
| p90 `waitMs` (team) | < 90s | the rotation's real cost |
| abandonment | < 15% of started games | the strongest "this is not fun" signal |
| rematch rate | as high as it will go | the strongest "this is fun" signal |

A CI check that fails when the harness moves outside these ranges turns balance from a
thing we remember to check into a thing that tells us.

## 9. Order of work

1. ~~**`PlyMetric` plus server-side recording plus the archive block.**~~ **Done.**
2. ~~**The shared metric module**, with `balance.mjs` switched over to it.~~ **Done.**
3. **Insights aggregate and the admin dashboard** — distributions and mode health.
4. **The post-game report** for players.
5. **The client telemetry channel** — indecision, device, premoves.
6. **Guardrails in CI.**

Steps 1 and 2 carried most of the value: the mode is now measurable in real play and the
simulation is computed by the same code as production. Steps 3 to 6 are consumers.

### What changed on the way

`computeChoiceSet` counts a castle as affordable only when the hand can pay the Rook card
it costs, which no earlier version did — neither the server's reach nor the harness's. The
shipped `open` rate moved from 18.8% to 20.6% when the harness switched over, and the
second number is the correct one.

`hung` and `missed` are computed from material rather than from the bot's scorer as first
planned. The scorer carries a random tiebreak, which would have put noise in a stored
metric, and material needs no move generation beyond the one the hanging check already
does. It is the cheaper *and* the more stable of the two.
