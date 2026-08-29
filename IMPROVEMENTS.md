# Improvements

What could be better in Bolotnoye Logovo, ordered by impact. Sound assets are in
[§2](#2-sound-assets-needed).

---

## 0. Done in this round — the three that were picked

The list below ended by naming three things worth doing first. All three are in.

**a. Victory, defeat and draw are three sounds now.** They were one sample — a card being
dealt — played identically whether you had just won, lost or drawn. Each now has its own
voice, synthesized rather than borrowed: victory is a G major arpeggio over a brass swell,
defeat the same shape inverted and sagging flat, draw a bare fifth struck twice and never
resolved by a third. **Which one you hear depends on your own result**, so the two teams
hear different things at the same moment. Spectators get the decisive cue. The takeback
exchange got its own three (ask, accept, decline), and chat and marks got near-subliminal
ticks. `swell()` in `audio/sfx.ts` is the new voice: two detuned saws through a lowpass that
opens on the attack. None of this closes [§2](#2-sound-assets-needed) — real recordings
would still be better — but nothing in the endgame is a stand-in any more.

**b. Team chat and ghost-marking.** Teammates in a rotation could not coordinate at all,
which in a *team* game was the largest hole in the design. Both are now in, and both are
**team-scoped at the server**: `eachMember()` hands each socket only what its own channel
may see, rather than broadcasting everything and asking the client to hide it — the latter
is readable in devtools, which in a game about coordinating a team is the whole exploit.
Chat lives outside `RoomState` for the same reason. Marks are right-click (or **X**), cost
one round trip, are capped at six per player, and expire the moment a ply is played: a
suggestion means nothing outside the position it was made in. Rate limiting is a six-deep
token bucket per socket, refilled at one message every two seconds.

**c. Keyboard play, and a board a screen reader can read.** The board was pointer-only. It
is now a real ARIA grid — eight `role="row"` wrappers at `display: contents`, so the CSS
grid is untouched and the row structure the role requires still exists — with a cursor on
arrow keys, Enter to select and move, Esc to drop, Home/End along a rank, and X to mark.
Every square announces its piece, whether it is a legal target, whether it is marked and
whether the king there is in check; moves, handoffs, takebacks and the result are announced
as they happen. **C** and **B** jump between the chat box and the board.

Four smaller things came with them, all found by reading the code rather than by using it:

- **The check highlight was drawing in the wrong place.** Every marker is positioned by an
  inline `transform: translate(...)`, and `check-pulse` animated `transform` — which outranks
  inline style. So for the 1.8s of the animation the check marker sat scaling in the corner
  of the board, then snapped onto the king. The pulse moved to `::before`, which has no
  inline transform to lose.
- **Check no longer relies on colour alone**: a dashed ring says it by shape too.
- **`--text-faint` was 2.7:1 on `--panel`**, well under the 4.5:1 floor and the worst
  offender in the palette. It is `#8A8378` now — 4.8:1 on panel, 5.3:1 on `--bg`.
- **Socket listeners were accumulating.** `net.onFx` and friends used `socket.on`, and the
  room view is rebuilt on every route change, so re-entering a room played every sound twice.
  They rebind now.

`test/integration.mjs` covers the new server behaviour: 52 assertions, including that the
opposing team receives neither chat nor marks.

**Not verified visually.** Browser tooling was unavailable in the session that wrote this,
so the new panel and markers have been typechecked, built and covered by server tests, but
nobody has looked at them. That is exactly the gap [§7](#7-testing) is about.

---

## 0b. Fixed earlier — the timer fire

Reported as *"I don't see fire effects and animations for the timer, it just rotates."*
Two separate defects, both real:

**a. Reduced-motion killed it outright.** The fire was gated on
`prefers-reduced-motion`, and this machine reports `reduce` because Windows has
**Settings → Accessibility → Visual effects → Animation effects** turned off
(`HKCU\Control Panel\Desktop\WindowMetrics\MinAnimate = 0`). Many people switch that off for
performance, not for vestibular reasons, so treating it as "draw nothing" was too blunt — and
it failed silently.

*Fix:* three motion levels instead of a boolean. `prefers-reduced-motion` now maps to **calm**
(fire still burns, ~⅓ the particles, no flicker, no ember showers) rather than **off**. Full
effects and fully off are both reachable with **E** or the ✦ button, and the choice persists.

**b. The panel was clipping it.** The fire canvas is deliberately 244px wide around a 152px
ring so flames are not cut off at the stroke radius — but `.panel { overflow: hidden }` sheared
~28px off every side.

*Fix:* the timer panel opts out via `.panel-fire { overflow: visible }`.

**If it still looks static**, in order of likelihood: the page is serving a stale bundle (stop
the server, `npm run build`, `npm start`, then hard-reload with Ctrl+Shift+R); or effects were
previously toggled off and the choice was remembered — clear it with
`localStorage.removeItem('bl.motion')` in the console, or press **E** twice.

---

## 1. Where the timer could still go further

The ring is now a burning fuse with a glow bed, particle flame and embers. Still open:

- **Smoke.** Above the flame head there should be a thin dark plume drifting up and dissipating.
  Cheap to add (same particle system, dark colours, `source-over` instead of `lighter`).
- **Heat distortion.** A subtle refraction ripple over the numerals as time runs out. Needs a
  WebGL pass or a CSS `filter: url(#turbulence)` — the SVG-filter route is cheaper and probably
  enough.
- **Ash fallout.** Embers currently rise and fade. Some should cool, darken and fall.
- **The number should react.** At <5s the digits could char, flicker or shed sparks; right now
  they only change colour.
- **Burn-through at zero.** When the clock expires the ring could snap and the ends recoil,
  rather than the fire simply stopping.
- **Per-team ember colour**, so a glance at the ring says whose clock is running.

## 2. Sound assets needed

**22 sounds wanted, 12 available, and only 4 of those were recorded for anything resembling
chess.** The `Assets/` pack is a card-and-dice library; the rest are stand-ins.

Deliver as **48 kHz / 24-bit WAV masters**, exported to **ogg + mp3** (the loader prefers ogg
and falls back to mp3). Peaks near **−6 dBFS**, heads trimmed to zero-crossing — several fire
back-to-back and any leading silence reads as lag.

### Priority 1 — genuinely missing

Nothing recorded exists for these. The first three are **now synthesized and distinct**
(see §0), which fixes the flatness; the table stands as the brief for replacing the
synthesis with real recordings, which would still be better.

| # | Event | Length | Character |
|---|---|---|---|
| 1 | **Victory** | 2.0–3.5 s | *Synthesized: G arpeggio over a brass swell.* Warm, resolved, ascending. Earned, not arcade-cheerful. |
| 2 | **Defeat** | 2.0–3.0 s | *Synthesized: the same shape inverted, bending flat.* Descending, hollow, resigned. Never comedic. |
| 3 | **Draw / stalemate** | 1.5–2.5 s | *Synthesized: a bare fifth, no third.* Neutral and unresolved. Distinct from both above. |
| 4 | **Your turn** | 0.4–0.7 s | *Currently a synthesized D5→G5 bell — usable, but a real recording would be better.* A soft unmistakable summons; marimba or muted chime. |
| 5 | **Clock tick** | 0.05–0.1 s | Dry mechanical escapement, felt more than heard. Currently a sine blip. |
| 6 | **Clock tick, urgent** | 0.08–0.15 s | Same mechanism, harder and brighter. Fires once per second under 5 s. |
| 7 | **Timeout / auto-move** | 1.0–1.8 s | The signature failure sound. Wooden clatter into a hollow thud — the board deciding for you. Should sting. |
| 8 | **Illegal move** | 0.15–0.25 s | Dull, damped, non-musical. A knuckle on felt. Not an error beep. |

### Priority 2 — borrowed and audibly wrong

Playable today, but they betray the card-pack origin.

| # | Event | Currently | Should be | Length |
|---|---|---|---|---|
| 9 | **Check** | `piece-impact-2` pitched up | Its own alarm — tensioned metallic ring, bright and short | 0.3–0.5 s |
| 10 | **Castle** | `deck-deal-1` (*cards dealing*) | Two pieces sliding and settling in sequence | 0.5–0.8 s |
| 11 | **Promotion** | `dice-roll-1` (*dice tumbling*) | Rising shimmer resolving to a solid set-down | 0.8–1.2 s |
| 12 | **Game start** | `deck-shuffle-2` | Pieces being set — a small ordered flurry ending in one firm placement | 1.0–1.5 s |
| 13 | **Seat taken** | `paper-flip-1` | A chair-pull or soft wooden knock | 0.2–0.4 s |

### Priority 3 — silent events

No sound at all today. Each is a moment a player can miss entirely.

| # | Event | Length | Character |
|---|---|---|---|
| 14 | **Takeback requested** | 0.4–0.6 s | *Synthesized: a rising minor third, asked only of the team that must answer.* |
| 15 | **Takeback accepted** | 0.5–0.8 s | *Synthesized: the same interval falling.* |
| 16 | **Takeback declined** | 0.3–0.5 s | *Synthesized: one flat, damped note.* |
| 17 | **Player joined** | 0.3–0.5 s | Light and welcoming, quieter than #13 |
| 18 | **Player disconnected** | 0.4–0.6 s | The same idea inverted and dimmed |
| 19 | **Button hover** | 0.03–0.06 s | *Currently a pitched-down dice pickup at 11 % gain.* Near-subliminal tick. |
| 20 | **Rotation handoff** | 0.2–0.4 s | Soft mechanical advance under the seat animation — a ratchet tooth |
| 23 | **Message received** | 0.03–0.06 s | *Synthesized tick.* One arrived; not what it says |
| 24 | **Square marked** | 0.04–0.08 s | *Synthesized tick, brighter for your own mark than a teammate's* |

### Priority 4 — atmosphere

| # | Asset | Length | Notes |
|---|---|---|---|
| 21 | **Ambient bed** | 60–120 s seamless loop | Very low room tone: distant hall, faint fire. −30 dBFS or lower, off by default. |
| 22 | **Low-time bed** | 10–20 s loop | Rising tension fading in under 10 s, ducking everything else slightly. |

### Sourcing

- **Free / permissive:** [freesound.org](https://freesound.org) (filter CC0),
  [Kenney](https://kenney.nl/assets?q=audio) (CC0, arcade-flavoured — better for UI than for
  the emotional cues)
- **Paid, closest to this brief:** [Sonniss GDC bundles](https://sonniss.com/gameaudiogdc)
  (free annually, professionally recorded), [A Sound Effect](https://www.asoundeffect.com)
- **Record your own:** items 9–13 and 20 are physical wooden-chess-set actions. A real set, a
  quiet room and a decent mic beat any library — they are exactly what a card pack cannot fake.

### Naming

Drop files into `client/public/sfx/{ogg,mp3}/` as kebab-case and add the name to `SAMPLES` in
`client/src/audio/sfx.ts`. Until a file exists the loader keeps the current stand-in, so these
can land one at a time.

```
victory        defeat          draw            your-turn
tick           tick-urgent     timeout         illegal
check          castle          promote         game-start
seat-take      takeback-ask    takeback-yes    takeback-no
player-join    player-leave    ui-hover        handoff
ambient-room   ambient-tension
```

### The audio system, not just the assets

- **Volume slider**, not only on/off. Master plus separate SFX and ambient buses.
- **Ducking** — the low-time bed should pull everything else down 3–4 dB, not pile on.
- **Preload gating** — the first move of a game can be silent while buffers decode. Hold the
  lobby until the critical samples are in.
- **Positional weighting** — your own moves slightly louder than the opponent's.

## 3. Visual and interaction

Done recently: stepped slider and segmented control replacing native `<select>`s, gradient
panel edges, layered elevation, specular sweep on the primary button, particle fire, and the
your-move screen bloom.

Still open:

- **Piece set.** The king and bishop still read similarly at small board sizes. Commission a
  set, or license one (Cburnett is GPL — fine only if the project goes GPL).
- **Board materials.** Squares are flat fills. Subtle tiled wood grain plus a frame bevel would
  close most of the remaining gap.
- **Move-quality feedback.** Nothing distinguishes a blunder from a brilliancy. Even a shallow
  material-swing eval could tint the move-history row.
- **Capture animation.** Captured pieces fade in place; sliding them to the tray would connect
  cause and effect.
- **Mobile.** The layout reflows and input is pointer-based, so it works, but drag thresholds
  and tap targets are untuned and it has had no real touch testing.

## 4. Gameplay

- ~~**Team chat**~~ and ~~**ghost-marking**~~ are in (§0). What they open up next:
  **drawn arrows** rather than only squares, a **mark that survives one ply** for plans that
  span a turn, and marks visible to **spectators watching a team** rather than nobody.
- **Spectator mode** is still half-built: spectators are counted and now have their own chat
  channel, but there is no dedicated view.
- **Increment / delay** — Fischer bonus per move, Bronstein delay.
- **Handicaps** for uneven teams; **rematch with sides swapped**.
- **Stronger bot.** The current one is one-ply greedy. A 3-ply alpha-beta with piece-square
  tables would make bot seats respectable rather than filler.

## 5. Technical

- **Rooms are in-memory.** A server restart drops every game in progress.
- **No rate limiting.** A client can spam `room:create` and exhaust memory. Cap per IP, add a
  total ceiling with LRU eviction.
- **No room expiry.** Rooms are cleaned only when the last socket leaves; an abandoned room
  with a tab left open lives forever.
- **Reconnect is silent.** A dropped socket keeps the clock running server-side — correct, but
  the player gets no warning they are burning time while offline.
- **`types.ts` is copied, not shared**, between server and client. A shared workspace package
  would stop the two drifting.
- **No logging or metrics.** Nothing records games played, timeout rates, or crashes.

## 6. Accessibility

Was the weakest area. Most of it is now done — see §0 — and what is left is narrower:

- ~~Keyboard play~~, ~~ARIA grid semantics~~, ~~move announcements~~, ~~the check square's
  second cue~~ and ~~`--text-faint` contrast~~ (2.7:1 → 4.8:1) are done.
- **The rest of the palette is still unaudited.** `--text-faint` was measured because it was
  the obvious suspect; nothing else was. A contrast sweep over every token pair in use would
  settle it.
- **No skip link, and the tab order has not been reviewed.** Reaching the board takes a Tab
  through the whole top bar; C and B are a shortcut around that, not a fix for it.
- **The promotion dialog does not trap focus** and cannot be dismissed with Escape.
- **Motion is three-level** (full / calm / off) and honours the system default, but there is
  still no in-app control for the your-move screen bloom specifically.
- **Drag-and-drop has no keyboard equivalent for the tray or the roster** — seats are taken
  with buttons, so they work, but nothing announces that control has changed hands except
  the live region on the board.

## 7. Testing

- `test/integration.mjs` covers the server well — 52 assertions over rotation, timers,
  takeback, bots, reconnect, checkmate, and team-scoped chat and marks.
- **The client still has no automated tests at all.** The UI has only ever been verified by
  screenshot, which is how both fire bugs survived — and the check-marker bug in §0 survived
  the same way, for however long the check highlight has existed.
- No unit tests for isolable pure logic: `capturedInfo`, slider stop mapping, the
  piece-matching reconciliation in `board.ts`, `describe()` and the mark diff in `board.ts`,
  and `ChatPanel.setMessages`'s append-or-rebuild decision. This is now the highest-value
  gap in the project: adding a runner (vitest, one devDependency) would let all of it be
  tested in an afternoon.
- No load test. Behaviour at 100 concurrent rooms is unknown.

---

## If I picked three (next)

The previous three are done (§0). What I would take now:

1. **A client test runner.** Every bug found by reading rather than running — the check
   marker, the doubled socket listeners — was cheap to have caught and expensive to have
   missed. One devDependency and the pure logic is covered.
2. **Rooms in memory, with no expiry and no rate limit** ([§5](#5-technical)). Chat added a
   text channel with a limiter; room creation still has neither cap nor eviction, and a
   restart still drops every game in progress.
3. **A stronger bot** ([§4](#4-gameplay)). One-ply greedy makes bot seats filler; 3-ply
   alpha-beta with piece-square tables would make them a real option for uneven teams,
   which is the situation this game format produces constantly.
