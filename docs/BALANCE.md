# Chess Cards — balance

The mode's premise is *"I can see the move — can I play it?"*, which only works if the
answer is often no. The design doc's suggested numbers — a hand of five, four Wilds in
thirty-six — did not deliver that, and playtesting said so directly:

> Feels like I have too many moves. Like I always can move almost any piece.

This is the measurement that followed, and why the shipped numbers differ from the doc's.

## How it is measured

`npm run balance -- --all` plays a few hundred games. Both sides pick uniformly at random
from the moves their hand can actually pay for, running the real engine in
`server/src/cards.ts` — the same draw, spend, reshuffle and emergency code the server runs
— and records, at every turn, how much of the board the hand was holding shut.

| metric | meaning |
|---|---|
| **open** | turns where *every* legal move was affordable anyway — the cards did nothing |
| **moves** | share of legal moves the hand could pay for |
| **types** | share of movable piece types the hand could reach |
| **emerg** | turns the safety net had to open |
| **wild** | turns holding at least one Wild |
| **king** | turns where the only affordable move was a king move |
| **kinds** | distinct card kinds in hand |

`open` is the one that matters most. It is the share of turns on which the whole mechanic
was inert.

## What the numbers said

300 games, 60 plies each:

| tuning | open | moves | types | emerg | wild | king | kinds |
|---|---|---|---|---|---|---|---|
| doc: hand 5, 4 wild | **32.6%** | 72.5% | 78.0% | 1.1% | 26.2% | 0.5% | 3.39 |
| tight deck, hand 5 | 15.8% | 65.8% | 72.3% | 1.4% | 6.7% | 0.4% | 3.25 |
| tight deck, hand 4 | 11.6% | 60.5% | 67.3% | 1.9% | 5.4% | 0.6% | 2.96 |
| **tight deck, hand 3 — shipped** | **9.3%** | **55.7%** | **62.2%** | **2.6%** | 4.4% | 0.6% | 2.60 |
| heavy deck, hand 3 | 8.9% | 57.2% | 61.8% | 2.1% | 4.5% | 0.7% | 2.56 |
| light deck, hand 3 | 9.7% | 48.1% | 59.5% | **5.0%** | 3.5% | 0.5% | 2.50 |
| tight deck, hand 2 | 8.6% | 49.3% | 55.8% | **4.2%** | 3.5% | 0.4% | 2.16 |

Three things fall out of that table.

**Wild was most of the problem.** Four copies in thirty-six put a Wild in 26% of turns, and
a Wild unlocks every piece at once. Cutting it to one copy, changing nothing else, halves
`open` from 32.6% to 15.8%. It is the single biggest lever in the mode, and it was being
pulled by a card the doc describes as "страховка, а не стандартный ход" — insurance, not a
standard move.

**Hand size was the rest.** Six kinds exist. A hand of five holds 3.4 distinct ones, which
covers most of what any position offers; three holds 2.6. Constraint comes from
*duplicates*, not from card count — five cards over five kinds is no constraint at all.

**Pawn weight trades `moves` against `emerg`, and the trade has a floor.** One pawn card
unlocks eight pawns, so a pawn-heavy deck lowers the number of distinct kinds while
*raising* the share of legal moves affordable. Cutting pawns pushes `moves` down to 48% —
but drives the emergency move from 2.6% of turns to 5.0%, roughly three times a game. The
doc is explicit that it is "a safety net, not a normal way to play", so that is the wall.
Hand-of-two hits the same wall from the other direction.

That first pass landed just inside it: the cards were inert on 1 turn in 11 rather than 1
in 3, you could play a bit over half your legal moves rather than three-quarters, and the
safety net opened about once every forty turns. The section after next is what happened
when it was played rather than simulated.

## The second retune: a hand you can hold something in

The hand of three measured beautifully and played thin. Three cards is a hand you read in
a second and then wait out, and the second round of playtesting asked for the opposite of
what the first one did:

> Maybe increase hand size (but limit it up to 7 cards) and have incoming cards of 2
> instead of 1, maybe for start let's have 1 card per piece in hand.

All three are now the shipped economy, and the shape of it changed as well as the size.
There is no draw *target* any more:

- **the opening hand is one card per piece kind** — Pawn, Knight, Bishop, Rook, Queen —
  dealt out of the deck rather than added to it, so no game begins stuck and the first
  turn is the one turn you can do anything;
- **two cards are dealt at the start of each turn**, three once enrage is on, against the
  one card a move costs;
- **the hand caps at seven**, the design doc's own figure, and at the cap the deal simply
  does not happen.

### What it cost, measured

300 games, 60 plies, against the same harness:

| tuning | open | moves | types | emerg | kinds | hand | at cap |
|---|---|---|---|---|---|---|---|
| old: refill to 3 | **5.1%** | 53.8% | 56.9% | 1.2% | 2.24 | 3.00 | — |
| old: refill to 5 | 9.6% | 66.7% | 67.5% | 0.9% | 2.87 | 5.00 | — |
| **deal 2, cap 7 — shipped** | **26.2%** | 72.6% | 79.3% | 0.6% | 3.66 | 6.90 | **93%** |
| deal 2, cap 6 | 20.1% | 67.7% | 75.5% | 0.9% | 3.44 | 5.97 | 97% |
| deal 2, cap 5 | 13.9% | 61.5% | 70.2% | 1.1% | 3.19 | 5.00 | 100% |
| deal 1, cap 7 | 21.2% | 69.3% | 76.8% | 0.9% | 3.54 | 6.40 | 67% |

This is a real loosening and it should be stated plainly rather than buried: **`open`
triples, from 1 turn in 20 to better than 1 in 4.** On a quarter of turns the cards now
do nothing at all — which is roughly where the design doc's original numbers sat, and
where the first playtest said it was too loose.

Three things are worth knowing about that table before changing anything on the strength
of it.

**The cap is the whole story; the deck composition is noise.** `tight`, `heavy` and
`heavier` — decks ranging from 11 to 17 pawns — land within a point of each other at
25–26%. Six card kinds exist and a seven-card hand holds 3.7 of them however the deck is
weighted. Duplicates were the lever that worked at a hand of three, and at a hand of seven
they have almost nothing left to pull. If the mode needs to be tightened, the constant to
change is `handMax`, and `handMax` alone: 7 → 6 buys six points, 7 → 5 buys twelve.

**A hand of seven sits at seven.** Two cards in against one card out means the hand is at
the cap on 93% of turns, and that has a knock-on the numbers do not show: section 8's
tempo bonus and section 10's card lock are close to inert. A capture "draws you an
extra card" that the next turn's deal would have given you anyway, and a card "kept back"
costs you nothing, because the draw you decline was one you could not have taken. The two
decisions those rules exist to create only really exist below the cap — which is what the
`deal 1, cap 7` row is: the hand fluctuates, sitting at the cap two turns in three.

**The sacrifice is the sink this economy was missing.** Three cards for one move of any
piece, once every ten plies, is the only thing in the mode that takes more out of a hand
than a turn puts in — and it exists precisely because a big hand makes the *other* kind of
frustration rarer while doing nothing about the sharp one, which was never "I have no
cards" but "I have five good cards and not the one this position is asking for". It is
deliberately not modelled by the harness: the harness plays random affordable moves, and a
sacrifice is the least random decision in the game.

## The shipped tuning

`TUNING` in `server/src/cards.ts` is the only place these live.

| | doc | first pass | shipped |
|---|---|---|---|
| Opening hand | 5 random | 3 random | **one per piece kind (5)** |
| Per-turn deal | refill to 5 | refill to 3 | **2** |
| Per-turn deal, enraged | refill to 6 | refill to 4 | **3** |
| Hand cap | 7 | 7 | 7 |
| Sacrifice cost / cooldown | — | — | **3 cards / 10 plies** |
| Pawn | 10 | 11 | **14** |
| Knight | 7 | 8 | 8 |
| Bishop | 7 | 8 | **7** |
| Rook | 5 | 5 | **4** |
| Queen | 3 | 3 | **2** |
| **Wild** | **4** | **1** | **1** |
| Deck total | 36 | 36 | 36 |

## A card cannot outlive its piece

A second playtest note:

> There is a bug where when we ran out of pieces, for example knights, we still have those
> cards on hand. It makes sense to replace them.

A card for a piece type you no longer own is not dead in *this* position — it is dead in
every position that can follow, so it is not a constraint at all, just a smaller hand.
Cards for extinct types are now swapped out at the start of the turn.

The averages barely move, because in the first fifty plies almost nothing has been traded.
The endgame is a different story. From ply 50 on, over 140 games of 160 plies:

| from ply 50 | holding dead cards | swapping them out |
|---|---|---|
| dead cards held (of a hand of 3) | **1.19** | **0.00** |
| emergency move fires | **11.4%** | **6.0%** |
| moves affordable | 52.2% | 55.1% |
| types reachable | 63.5% | 67.5% |
| open (cards inert) | 16.3% | 17.1% |

Nearly **forty percent of the hand** was permanently dead weight by the endgame, and the
emergency move — designed to fire on 2.6% of turns — was opening on more than one turn in
nine. That is precisely the "safety net becoming a normal way to play" the doc warns
against, arrived at by accident.

The important column is the last one. `open` moves by 0.8 points, so the cards still
constrain just as often as before; what changed is that the player is no longer holding
junk while they do it. The fix removes dead weight without loosening the mode.

`BALANCE_NO_SWAP=1 npm run balance` reproduces the left-hand column.

## The dead hand: cycling, not the emergency move

Section 7 of the design doc asks for *draw protection*: a hand that cannot move anything
should be dealt past until it can. That was standing in badly for the emergency move,
which is a far bigger gift — it opens every piece at once, where cycling hands you one
card — and which charges for it, so the ordinary case of "my cards happen to be useless
this turn" was both over-rewarded and fined.

Cycling now runs first, and free: dead cards go to the discard one at a time until
something in hand can move. The emergency move stays for the one case cycling must not
answer — **being in check**, where the position is asking a question that has to be
answered this turn and cycling could spend the whole deck without finding a card that
answers it.

## Re-tuning

Change `TUNING`, then run `npm run balance`. Nothing else hardcodes these numbers: both
test suites read the shipped figures rather than restating them, and the client renders
whatever deal, cap and sacrifice price the server publishes. The one place the figures are
deliberately pinned is the deck-composition assertion at the top of `test/cards.mjs`, so
that changing the deck is a decision someone has to make on purpose.

`npm run balance -- --all` sweeps the candidates, including the old refill-to-a-target
rows, so any change can be read against what came before it.

Two caveats on the harness. It plays *random* affordable moves, so it measures how much the
cards restrict, not how much a good player minds being restricted — a human steers toward
positions their hand suits, which real play should make gentler than these figures. And it
does not model the mulligan, which is one free reroll a game and would nudge `open` up
slightly.
