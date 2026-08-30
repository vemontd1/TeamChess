# Mythical — a 12×12 board with pieces chess does not have

Asked for in a bug report, in one line: *"introduce new game mode. Mythical it should be
12x12 chess with new figure types like dragon, unicorn etc think on this"*.

This is the thinking, written down before any of it is built, because the honest answer to
"how long is this" turns on one fact that is easy to miss.

## The one fact that decides everything

**Every rule in this app is `chess.js`, and `chess.js` is 8×8.**

Not "mostly 8×8". Its board is a 128-entry array with a hard-coded 0x88 layout, its
squares are `a1`–`h8` by name, its FEN parser rejects anything else, and its move
generator has the piece list compiled in. There is no size parameter and no piece hook.
The server uses it for legality, check, mate, stalemate, threefold, the fifty-move rule and
SAN; the client uses it for the board's own legal-move dots and for premove targets; the
metrics module counts through it; the bots search with it; the archive stores its FENs and
its SANs, and the review screen seeks through those.

So Mythical is not a mode. Modes here are rules layered *on top of* chess — Chess Cards
says which piece you may move and changes nothing about how pieces move. Mythical changes
what a board is and what a piece does, which means a second engine.

## What a second engine has to do

Everything the app currently gets for free:

| what | who needs it |
|---|---|
| move generation for 12 new piece kinds | server legality, client dots, premoves, bots |
| check, checkmate, stalemate | game end, the clock's forced move, the result |
| repetition and a fifty-move equivalent | draws |
| a position format | the archive, the review screen, bug reports, `startFen` |
| a move notation | history, PGN export, the move list, `docs/METRICS.md` |
| a value per piece kind | material, `hung`, `missed`, the bots' scorer |

That is the whole spine of the project. It is perfectly doable — a 12×12 board with
sliding and leaping pieces is a well-understood thing to write — but it is a *core*
project, not a feature: I would put it at several sessions of work, most of it in tests,
and the risk is concentrated in the places that are hardest to see going wrong (a mate
detected one ply late; a repetition rule that never fires).

## What I would build, in order

1. **A board module that is not chess.js.** `Board12` with its own 12×12 representation,
   its own move generation, and a `Rules` object describing each piece as leaper and slider
   offsets. Chess itself is expressible in it, which is the test: run the existing card
   engine against `Board12` configured as ordinary chess and every current test must pass
   unchanged. Nothing ships until that holds.
2. **The pieces.** Starting set, all expressible as offsets, so the engine needs no special
   cases:
   - **Dragon** — moves as queen *or* knight. The strongest piece on the board, one a side.
   - **Unicorn** — knight that may repeat its leap in the same direction (a "nightrider").
   - **Griffin** — one step diagonally, then slides orthogonally outward.
   - **Basilisk** — moves one square in any direction; any enemy it *would* attack may not
     move next turn. The one piece that is not pure geometry, and the one worth being
     careful about.
   - Plus the six ordinary kinds, on a wider back rank.
3. **Notation and FEN.** A superset: files `a`–`l`, ranks `1`–`12`, piece letters extended
   (`D`, `U`, `G`, `B`). Old games stay readable because old games say `schema` and this is
   a new one.
4. **The card deck for it.** Chess Cards over Mythical is the obvious pairing — a hand that
   might hold a Dragon card is a good hand — and the deck tuning is a balance question the
   existing harness (`npm run balance`) can answer once the engine is in place.
5. **The rest of the app follows for free**, because it was written against interfaces
   rather than against chess: metrics, the archive, the review screen and the admin panel
   all take a position and a move list and do not care how wide the board is. The one
   exception is the board component's square geometry, which is `8` in a dozen places.

## What I would not do

- **Not a fork of chess.js.** The 0x88 assumption is not localised; changing it is writing
  a new engine with someone else's tests attached.
- **Not "12×12 with ordinary pieces first".** A wider board with only chess pieces is a
  worse game than chess — the pieces are too slow to cover it, and it plays as a shuffle.
  The new pieces are the point; the size exists to give them room.
- **Not before the mode picker knows how to hold three.** The home screen now has two
  tiles; three fit, four do not, and that is a design change worth making deliberately
  rather than as a side effect.

## The recommendation

Worth building, and worth building as its own project rather than squeezed alongside bug
reports. The first step is small and self-contained — `Board12` passing the existing suite
as ordinary chess — and it is the step that proves the rest is affordable. If that lands
cleanly, the pieces are a pleasure and the rest is plumbing.

Say the word and I will start with step 1.
