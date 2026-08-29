/**
 * Effects preference.
 *
 * Three levels rather than a boolean, because the first cut of this was too blunt: it
 * treated `prefers-reduced-motion` as "draw nothing", so anyone whose OS reports it saw a
 * bare rotating ring and no explanation.
 *
 *   full  - particles, flicker, ember showers, throbbing halos
 *   calm  - the fire still burns, but slowly and without flicker, throb or ember showers
 *   off   - no canvas at all
 *
 * `prefers-reduced-motion` maps to `calm`, not `off`. What that setting is actually asking
 * to avoid is large, fast, unpredictable motion; a small localised glow at a fixed point on
 * screen is not that. On Windows the setting is wired to Settings > Accessibility > Visual
 * effects > Animation effects, which people routinely switch off for performance, so
 * treating it as "show nothing" silently punishes them. `off` stays available, but it has
 * to be chosen.
 */

export type MotionPref = 'auto' | 'full' | 'off';
export type MotionLevel = 'full' | 'calm' | 'off';

const KEY = 'bl.motion';
const mq = matchMedia('(prefers-reduced-motion: reduce)');
const listeners = new Set<(level: MotionLevel) => void>();

let pref: MotionPref = readPref();

function readPref(): MotionPref {
  const v = localStorage.getItem(KEY);
  if (v === 'full' || v === 'off') return v;
  // migrate the older on/off flag
  if (v === 'on') return 'full';
  return 'auto';
}

export function systemPrefersReduced(): boolean {
  return mq.matches;
}

export function getMotionPref(): MotionPref {
  return pref;
}

export function motionLevel(): MotionLevel {
  if (pref === 'full') return 'full';
  if (pref === 'off') return 'off';
  return mq.matches ? 'calm' : 'full';
}

/** Anything at all should be drawn. */
export function effectsEnabled(): boolean {
  return motionLevel() !== 'off';
}

export function setMotionPref(next: MotionPref): void {
  pref = next;
  if (next === 'auto') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, next);
  emit();
}

/** Cycle full -> off -> full, so the control is a plain on/off to the player. */
export function toggleMotion(): MotionLevel {
  setMotionPref(effectsEnabled() ? 'off' : 'full');
  return motionLevel();
}

function emit(): void {
  const lvl = motionLevel();
  for (const l of listeners) l(lvl);
}

mq.addEventListener('change', () => { if (pref === 'auto') emit(); });

export function onMotionChange(fn: (level: MotionLevel) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
