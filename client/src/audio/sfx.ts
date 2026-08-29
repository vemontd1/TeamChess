/**
 * WebAudio playback over the JDSherbert tabletop pack in public/sfx.
 *
 * Buffers are decoded once on the first user gesture (browsers refuse to start an
 * AudioContext before one). Clock ticks are synthesized because the pack has no tick,
 * and every sample gets slight rate jitter so repeated moves do not sound looped.
 */

type Sample =
  | 'piece-move-1' | 'piece-move-2' | 'piece-impact-1' | 'piece-impact-2'
  | 'deck-deal-1' | 'deck-deal-2' | 'deck-shuffle-1' | 'deck-shuffle-2'
  | 'dice-pickup-1' | 'dice-pickup-2' | 'dice-roll-1' | 'paper-flip-1';

const SAMPLES: Sample[] = [
  'piece-move-1', 'piece-move-2', 'piece-impact-1', 'piece-impact-2',
  'deck-deal-1', 'deck-deal-2', 'deck-shuffle-1', 'deck-shuffle-2',
  'dice-pickup-1', 'dice-pickup-2', 'dice-roll-1', 'paper-flip-1',
];

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;
let preloaded = false;
const buffers = new Map<Sample, AudioBuffer>();

// ogg is smaller and universally decodable in evergreen browsers; mp3 covers the rest.
const canOgg = (() => {
  try { return !!new Audio().canPlayType('audio/ogg; codecs="vorbis"'); }
  catch { return false; }
})();
const EXT = canOgg ? 'ogg' : 'mp3';

function ac(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.75;
    master.connect(ctx.destination);
  }
  return ctx;
}

export function setSoundEnabled(on: boolean): void { enabled = on; }
export function isSoundEnabled(): boolean { return enabled; }

async function loadOne(name: Sample): Promise<void> {
  if (buffers.has(name)) return;
  try {
    const res = await fetch(`/sfx/${EXT}/${name}.${EXT}`);
    if (!res.ok) return;
    buffers.set(name, await ac().decodeAudioData(await res.arrayBuffer()));
  } catch { /* silence is an acceptable failure mode */ }
}

/** Call from the first click/keypress: resumes the context and warms the cache. */
export function unlockAudio(): void {
  try { void ac().resume(); } catch { /* ignore */ }
  if (!preloaded) { preloaded = true; void Promise.all(SAMPLES.map(loadOne)); }
}

interface PlayOpts { gain?: number; rate?: number; delay?: number; }

function play(name: Sample, opts: PlayOpts = {}): void {
  if (!enabled) return;
  const buf = buffers.get(name);
  if (!buf) { void loadOne(name); return; }
  try {
    const a = ac();
    const src = a.createBufferSource();
    const g = a.createGain();
    src.buffer = buf;
    // +/-4% jitter keeps repeated identical events from sounding mechanical
    src.playbackRate.value = (opts.rate ?? 1) * (0.96 + Math.random() * 0.08);
    g.gain.value = opts.gain ?? 0.9;
    src.connect(g).connect(master ?? a.destination);
    src.start(a.currentTime + (opts.delay ?? 0));
  } catch { /* ignore */ }
}

/**
 * A struck-bell voice: sine fundamental plus a quiet inharmonic partial, with a fast
 * attack and a long exponential tail. The sample pack has no chime, and a pitched-up
 * paper flip -- what this used to be -- reads as a page turn, not a summons.
 */
function bell(freq: number, durMs: number, gain: number, delay = 0): void {
  if (!enabled) return;
  try {
    const a = ac();
    const t0 = a.currentTime + delay;
    const out = a.createGain();
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
    out.connect(master ?? a.destination);

    // fundamental + a 2.76x partial, the ratio that makes a bar sound struck
    for (const [mult, level, wave] of [[1, 1, 'sine'], [2.76, 0.28, 'triangle']] as const) {
      const osc = a.createOscillator();
      const g = a.createGain();
      osc.type = wave;
      osc.frequency.setValueAtTime(freq * mult, t0);
      g.gain.value = level;
      osc.connect(g).connect(out);
      osc.start(t0);
      osc.stop(t0 + durMs / 1000 + 0.05);
    }
  } catch { /* ignore */ }
}

/**
 * A sustained pad: two saws a few cents apart through a lowpass that opens on the attack
 * and closes as it decays. This is what gives victory its brass swell and defeat its cello
 * fall -- a bare oscillator has no body, and the sample pack has nothing that sustains.
 */
function swell(freq: number, durMs: number, gain: number,
               opts: { delay?: number; bend?: number; bright?: number } = {}): void {
  if (!enabled) return;
  try {
    const a = ac();
    const t0 = a.currentTime + (opts.delay ?? 0);
    const dur = durMs / 1000;
    const bend = opts.bend ?? 1;

    const filt = a.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = 0.8;
    filt.frequency.setValueAtTime(freq * 1.6, t0);
    filt.frequency.linearRampToValueAtTime(freq * (opts.bright ?? 6), t0 + dur * 0.22);
    filt.frequency.exponentialRampToValueAtTime(Math.max(90, freq * 1.4), t0 + dur);

    const out = a.createGain();
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(gain, t0 + dur * 0.2);
    out.gain.setValueAtTime(gain, t0 + dur * 0.45);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    filt.connect(out).connect(master ?? a.destination);

    for (const detune of [-7, 7]) {
      const osc = a.createOscillator();
      osc.type = 'sawtooth';
      osc.detune.value = detune;
      osc.frequency.setValueAtTime(freq, t0);
      if (bend !== 1) osc.frequency.exponentialRampToValueAtTime(freq * bend, t0 + dur);
      osc.connect(filt);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    }
  } catch { /* ignore */ }
}

/** Short synthesized blip -- used for clock ticks, which the sample pack lacks. */
function synth(freq: number, durMs: number, type: OscillatorType = 'sine', gain = 0.05): void {
  if (!enabled) return;
  try {
    const a = ac();
    const t0 = a.currentTime;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
    osc.connect(g).connect(master ?? a.destination);
    osc.start(t0);
    osc.stop(t0 + durMs / 1000 + 0.02);
  } catch { /* ignore */ }
}

let noise: AudioBuffer | null = null;

/** One second of white noise, generated once and reused as the body of the blast. */
function noiseBuffer(a: AudioContext): AudioBuffer {
  if (!noise) {
    noise = a.createBuffer(1, a.sampleRate, a.sampleRate);
    const ch = noise.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  }
  return noise;
}

/**
 * A detonation: a broadband crack that decays into a rumble, over a sine that falls
 * through two octaves as the sub-bass thump.
 *
 * The sample pack is a tabletop set -- dice, cards, wooden pieces. It has nothing
 * percussive enough to read as a clock running out, and a shuffled deck is exactly the
 * wrong idea: losing your turn to the clock should sound like something going wrong.
 */
function blast(gain = 0.5): void {
  if (!enabled) return;
  try {
    const a = ac();
    const t0 = a.currentTime;

    // noise through a lowpass that slams shut: crack first, rumble after
    const src = a.createBufferSource();
    src.buffer = noiseBuffer(a);
    const filt = a.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = 1.1;
    filt.frequency.setValueAtTime(5200, t0);
    filt.frequency.exponentialRampToValueAtTime(160, t0 + 0.85);

    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(gain * 0.22, t0 + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.1);
    src.connect(filt).connect(g).connect(master ?? a.destination);
    src.start(t0);
    src.stop(t0 + 1.15);

    // the sub thump underneath, falling 120Hz -> 30Hz
    const sub = a.createOscillator();
    const sg = a.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(120, t0);
    sub.frequency.exponentialRampToValueAtTime(30, t0 + 0.5);
    sg.gain.setValueAtTime(0.0001, t0);
    sg.gain.exponentialRampToValueAtTime(gain * 0.9, t0 + 0.02);
    sg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.75);
    sub.connect(sg).connect(master ?? a.destination);
    sub.start(t0);
    sub.stop(t0 + 0.8);
  } catch { /* ignore */ }
}

let moveToggle = 0;
let impactToggle = 0;

export const sfx = {
  /** Quiet move: alternating so consecutive moves differ. */
  move(): void {
    play(moveToggle++ % 2 === 0 ? 'piece-move-1' : 'piece-move-2', { gain: 0.85 });
  },
  /** Capture: the harder wooden hit. */
  capture(): void {
    play(impactToggle++ % 2 === 0 ? 'piece-impact-1' : 'piece-impact-2', { gain: 1.0 });
  },
  /** Castling slides two pieces, so the dealing sound fits better than a single knock. */
  castle(): void { play('deck-deal-1', { gain: 0.9 }); },
  /** Check: the impact pitched up so it reads as an alarm, not a move. */
  check(): void { play('piece-impact-2', { gain: 0.95, rate: 1.35 }); },
  promote(): void { play('dice-roll-1', { gain: 0.9 }); },
  /**
   * The clock ran out. The blast lands on the instant it expired; the scramble and the
   * knock behind it are the board picking a move at random and putting a piece down.
   */
  timeout(): void {
    blast(0.5);
    play('deck-shuffle-1', { gain: 0.6, delay: 0.10 });
    play('piece-impact-1', { gain: 1.0, delay: 0.34 });
  },
  /** The same detonation on its own, for an ending that is not a move. */
  explosion(): void { blast(0.5); },
  seatJoin(): void { play('paper-flip-1', { gain: 0.8 }); },
  /** A hand thrown away and redealt. */
  shuffle(): void {
    play('deck-shuffle-1', { gain: 0.85 });
    play('deck-deal-2', { gain: 0.7, delay: 0.34 });
  },
  /** One card leaving your hand to pay for a move. */
  cardPlay(): void { play('deck-deal-1', { gain: 0.55, rate: 1.2 }); },
  start(): void { play('deck-shuffle-2', { gain: 0.95 }); },

  /**
   * The three endgames used to be one sample -- a card being dealt, played identically
   * whether you had just won, lost or drawn. That flattened the only moment in a game
   * that carries any feeling, so each now has its own voice, and which one you hear
   * depends on your own result rather than the board's.
   */

  /** Victory: a G major arpeggio over a brass swell, ascending and landing resolved. */
  victory(): void {
    swell(98.00, 2400, 0.10, { bright: 7 });            // G2 bed
    bell(392.00, 1400, 0.17);                           // G4
    bell(493.88, 1500, 0.16, 0.15);                     // B4
    bell(587.33, 1700, 0.16, 0.30);                     // D5
    bell(783.99, 2600, 0.20, 0.46);                     // G5, the long amber tail
    swell(196.00, 1800, 0.06, { delay: 0.46, bright: 5 });
  },

  /** Defeat: the same shape inverted -- falling, detuned, and going nowhere. */
  defeat(): void {
    swell(146.83, 2600, 0.11, { bright: 3.2, bend: 0.945 }); // D3 sagging flat
    bell(293.66, 1300, 0.15);                                // D4
    bell(233.08, 1500, 0.14, 0.26);                          // Bb3
    bell(174.61, 2400, 0.15, 0.54);                          // F3
    swell(87.31, 1700, 0.07, { delay: 0.54, bright: 2.6, bend: 0.97 });
  },

  /** Draw: a bare fifth, struck twice and never resolved by a third. */
  draw(): void {
    swell(146.83, 1900, 0.08, { bright: 3.6 });   // D3
    bell(293.66, 1700, 0.15);                     // D4
    bell(440.00, 1900, 0.14);                     // A4 -- the open fifth
    bell(587.33, 1500, 0.09, 0.42);               // D5 an octave up, no third anywhere
  },

  /** Takeback asked: a rising minor third. A question, so it does not resolve. */
  takebackAsk(): void {
    bell(440.00, 700, 0.13);
    bell(523.25, 900, 0.12, 0.11);
  },
  /** Takeback accepted: the same interval falling -- the position going back. */
  takebackYes(): void {
    bell(523.25, 700, 0.12);
    bell(392.00, 1100, 0.13, 0.12);
    play('paper-flip-1', { gain: 0.22, rate: 0.85 });
  },
  /** Takeback declined: one flat, damped note. Polite, and over. */
  takebackNo(): void { synth(196, 220, 'triangle', 0.05); },

  /** A draw is offered: the takeback question, a fifth lower -- asked, not demanded. */
  drawOffer(): void {
    bell(329.63, 800, 0.13);
    bell(392.00, 1000, 0.12, 0.12);
  },
  /** A draw offer declined: the same damped no. */
  drawNo(): void { synth(196, 240, 'triangle', 0.06); },
  /** A team resigned: a short fall, and the board being put away. */
  resign(): void {
    bell(261.63, 900, 0.14);
    bell(196.00, 1500, 0.13, 0.18);
    play('deck-shuffle-2', { gain: 0.45, rate: 0.8 });
  },

  /** A message arrived for your team: a tick at the edge of hearing. */
  chat(): void { synth(1320, 34, 'sine', 0.028); },
  /** You marked a square. A teammate's mark is the same tick, quieter. */
  mark(own = true): void { synth(own ? 1046 : 784, 40, 'triangle', own ? 0.05 : 0.03); },
  click(): void { play('dice-pickup-2', { gain: 0.5, rate: 1.15 }); },
  /** Near-subliminal: audible as texture on hover, never as a sound in its own right. */
  hover(): void { play('dice-pickup-2', { gain: 0.11, rate: 1.7 }); },
  pickup(): void { play('dice-pickup-1', { gain: 0.35, rate: 1.2 }); },
  illegal(): void { synth(140, 110, 'sawtooth', 0.04); },

  /**
   * Three tiers of clock warning, climbing in pitch and level as the turn closes. The
   * old single tick sat at 0.035 gain -- below the move sounds it had to be heard over,
   * which is why a countdown could expire without anyone noticing it had started.
   */
  tick(): void { synth(660, 55, 'sine', 0.13); },
  tickUrgent(): void { synth(880, 65, 'triangle', 0.22); },
  /** The last three seconds: a double blip, so it reads as a different sound entirely. */
  tickFinal(): void {
    synth(1175, 60, 'square', 0.20);
    setTimeout(() => synth(1568, 80, 'square', 0.22), 90);
  },
  /**
   * Your move: a rising perfect fourth (D5 -> G5) under a soft wooden knock. Rising and
   * unresolved reads as a prompt; the interval is wide enough to cut through a room but
   * consonant enough to hear many times a game without grating.
   */
  yourTurn(): void {
    bell(587.33, 1500, 0.20);           // D5
    bell(783.99, 1900, 0.17, 0.13);     // G5
    play('paper-flip-1', { gain: 0.28, rate: 1.5 });
  },
};
