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

The shipped point sits just inside it: the cards are inert on 1 turn in 11 rather than 1 in
3, you can play a bit over half your legal moves rather than three-quarters, and the safety
net opens about once every forty turns.

## The shipped tuning

`TUNING` in `server/src/cards.ts` is the only place these live.

| | doc | shipped |
|---|---|---|
| Hand / draw target | 5 | **3** |
| Draw target once enraged | 6 | **4** |
| Hand cap | 7 | 7 |
| Pawn | 10 | **11** |
| Knight | 7 | **8** |
| Bishop | 7 | **8** |
| Rook | 5 | 5 |
| Queen | 3 | 3 |
| **Wild** | **4** | **1** |
| Deck total | 36 | 36 |

## Re-tuning

Change `TUNING`, then run `npm run balance`. Nothing else hardcodes these numbers: both
test suites read the shipped target rather than restating it, and the client renders
whatever draw target the server publishes. The one place the figures are deliberately
pinned is the deck-composition block at the top of `test/cards.mjs`, so that changing the
deck is a decision someone has to make on purpose.

Two caveats on the harness. It plays *random* affordable moves, so it measures how much the
cards restrict, not how much a good player minds being restricted — a human steers toward
positions their hand suits, which real play should make gentler than these figures. And it
does not model the mulligan, which is one free reroll a game and would nudge `open` up
slightly.
