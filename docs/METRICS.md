# Metrics — what to measure, and why

**All six steps are built.** Per-ply recording and the archive block; the shared module
that `test/balance.mjs` computes through; the insights aggregate behind the admin panel's
Metrics tab; the player's own game report and the trends on their profile; the client
telemetry channel; and a guardrail check that fails when the simulation drifts outside the
targets in section 8. Section 9 is the order it happened in and what changed on the way.

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

**Built:** `client/src/net/telemetry.ts` sending, `telemetry:*` on the server receiving.

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

As built: three events, and no more than three. `telemetry:client` describes the browser
once per room; `telemetry:turn` reports one turn, after it has been played;
`telemetry:event` carries the two things that belong to a session rather than a move — the
review being opened and the phone drawer being pulled out. Everything is emitted
`volatile`, so a packet that cannot be delivered immediately is dropped rather than
queued, and every number is clamped on arrival rather than trusted.

The turn packet is sent **when the state carrying the move arrives, not when the server
acknowledges it**. The acknowledgement comes back first, and at that moment the client's
own store still describes the position the move was made *from* — so reporting there names
the wrong ply, and the server drops it. That was a real bug, caught by an integration test
written against the real socket rather than against a mock of one.

Three fields from the plan are not collected. `cardSelections` is, but as a count of picks
rather than of pick-and-unpick pairs; `premoveQueued` is not, because a queued move that is
never played leaves no turn to attach it to, and `fxLevel` rides along with the device
report rather than being its own field.

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
  Built: `server/src/insights.ts`. Counters only — no sample is kept, so every
  distribution is a **fixed-bucket histogram** and every percentile is interpolated inside
  the bucket it lands in. Changing a bucket bound is a schema bump, because old counts
  would otherwise be silently re-labelled; a schema change rebuilds from the archive on
  the next start, which is what makes a counter safe to add.
- The **funnel is the exception**: it counts rooms, and a room that was created and never
  started leaves nothing on disk. Those counters are live, and a rebuild deliberately
  keeps them rather than recomputing a number the archive cannot know.

## 5. One definition, two consumers

The most valuable structural change: put the metric computation in **one module that both
the live server and `test/balance.mjs` call**.

Today the harness keeps private copies of `open`, `moveCov` and `typeCov`. If real play and
simulation compute them even slightly differently then comparing them is worthless — and
comparing them is the entire reason to collect them. A shared `computePlyMetrics(chess,
side, …)` makes the harness a *predictor* of production rather than a second opinion.

## 6. What players get

**Built.** The report is `client/src/ui/gameReport.ts`, reached from the end-of-game card
and from any game in the review window; the trends are on the profile; the constraint line
is under the hand, on your turn, in cards mode only.

- **Game report** on the review screen: your think time against theirs, how constrained
  your hand actually was, cards drawn against cards spent by kind, the moves where material
  was left hanging, the material graph.
- **Profile trends**: hang rate and think time over time, win rate per mode, favourite
  setups.
- **In game, sparingly.** A constraint line ("4 of 11 legal moves affordable") is honest and
  useful; more than that becomes a second game played against the HUD. The board already
  dims unreachable pieces, which is the same information shown better.

## 7. What the admin gets

**Built**, as the Metrics tab of `#/admin`.

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

**Built.** The table above lives in one place -- `TARGETS` in `server/src/insights.ts` --
and has two consumers: the admin panel grades real play against it, and
`npm run guardrails` grades the simulation against it. Two lists would have been two
different definitions of the same target, which is the failure this whole document is
about.

The harness can only be held to what a random mover produces, so it checks the open rate
and the emergency rate; the rest -- sacrifices, timeouts, waits, abandonment, rematches --
need players, and are graded on the panel. Every guardrail there reports `unknown` rather
than a verdict until there is enough play behind it: a target argued from nine games is
worse than no target.

## 9. Order of work

1. ~~**`PlyMetric` plus server-side recording plus the archive block.**~~ **Done.**
2. ~~**The shared metric module**, with `balance.mjs` switched over to it.~~ **Done.**
3. ~~**Insights aggregate and the admin dashboard** — distributions and mode health.~~
   **Done.**
4. ~~**The post-game report** for players.~~ **Done.**
5. ~~**The client telemetry channel** — indecision, device, premoves.~~ **Done.**
6. ~~**Guardrails in CI.**~~ **Done.**

Steps 1 and 2 carried most of the value: the mode is now measurable in real play and the
simulation is computed by the same code as production. Step 3 made it readable, step 6 made
it self-reporting, step 4 gave the measurements back to the person they are about, and step
5 added the half of a turn the server cannot see.

### What changed on the way

`computeChoiceSet` counts a castle as affordable only when the hand can pay the Rook card
it costs, which no earlier version did — neither the server's reach nor the harness's. The
shipped `open` rate moved from 18.8% to 20.6% when the harness switched over, and the
second number is the correct one.

### What changed building the dashboard

**Distributions had to become histograms.** A rolling aggregate cannot keep samples, so
p50 and p90 are read off fixed buckets and interpolated. That is exact to the bucket width
and no further, which is why the buckets are narrow where the answers matter -- the first
ten seconds of a think, the first minute of a wait -- and open-ended at the top.

**Each target got its own sample floor.** Deriving it from the unit was wrong in the case
that mattered: an abandonment rate is a share of *games*, and holding it to two hundred
plies would have left it blank for months while the number it needed sat right there.

**The room funnel was added**, which section 2 asked for and nothing else could answer. It
is the only thing here that is not derived from the archive, and the only thing a rebuild
cannot restore.

**A preview harness** (`npm run preview:metrics`) renders the tab from simulated play to a
file. A dashboard cannot be designed against an empty database, and waiting for a hundred
real games before finding out that an axis label does not fit is the slowest possible way
to find out.

**The metrics tab renders as a pure string** (`client/src/ui/adminMetrics.ts`), with no DOM
behind it -- which is what lets the preview draw the real markup from Node instead of a
second copy of it that drifts.

### What changed building the report and the channel

**The report compares rather than grades.** Your numbers against your opponent's, on the
same axis, with the better of each pair marked by weight and a dot rather than by colour
alone. There is no score and no advice about what should have been played: the numbers are
measurements, and a measurement dressed up as a verdict is how a player learns to distrust
all of them.

**Every caveat is printed next to its number.** `hung` looks one ply ahead and does not
search the recapture, so a piece deliberately traded appears in "left hanging". Burying
that in this document and printing the bare count would have been the easier build and the
worse product.

**The profile stores its own copy of each side's roll-up.** A trend cannot be rebuilt from
a list of results, and the archive is capped -- so the roll-up travels onto the profile
with the game rather than being looked up later from a file that may be gone.

**The constraint line stops at one number.** "4 of 11 legal moves your hand can pay for",
on your turn, in cards mode. It is counted by the board with the same rule the server
records the ply with, so the line and the archive cannot disagree -- and nothing else is
shown mid-game, because a hang rate on screen turns the game into a second game played
against the HUD.

**The telemetry channel reports a turn late on purpose.** See section 3: the client waits
for the state that carries its own move before describing the turn, because the
acknowledgement arrives first and names the wrong ply.

`hung` and `missed` are computed from material rather than from the bot's scorer as first
planned. The scorer carries a random tiebreak, which would have put noise in a stored
metric, and material needs no move generation beyond the one the hanging check already
does. It is the cheaper *and* the more stable of the two.
