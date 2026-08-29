import { motionLevel, onMotionChange, type MotionLevel } from '../state/motion';

/**
 * Particle fire that burns down the countdown ring.
 *
 * The remaining time is a fuse: the surviving arc glows and smoulders, and its leading edge
 * carries a bright flame head that travels backwards around the ring as the clock drains.
 * Under 25% the fire deepens to orange, under 15% it goes red and throws embers.
 *
 * Three layers, all drawn additively (globalCompositeOperation 'lighter') so overlaps sum
 * into a hot core the way real flame does instead of muddying like alpha compositing:
 *   1. a soft glow bed traced along the remaining arc
 *   2. the particle field -- flame tongues and embers
 *   3. a bloom blob at the burning head
 *
 * The canvas is deliberately larger than the ring and sits ABOVE the SVG: flames rise well
 * outside the stroke radius, and drawing under a 7px opaque stroke hid the hottest part.
 */

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number;      // 1 -> 0
  decay: number;
  size: number;
  heat: number;      // 0..1, drives the colour ramp
  ember: boolean;
}

const MAX_PARTICLES = 420;
const TAU = Math.PI * 2;

/** heat -> rgb: white-hot through amber and orange down to a dull red. */
function heatColor(h: number): [number, number, number] {
  if (h > 0.86) return [255, 252, 236];
  if (h > 0.68) return [255, 226, 152];
  if (h > 0.48) return [255, 176, 66];
  if (h > 0.28) return [238, 108, 30];
  if (h > 0.12) return [190, 52, 18];
  return [120, 26, 12];
}

export class FireRing {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private parts: Particle[] = [];
  private raf = 0;

  private ring: number;      // ring radius
  private pad: number;       // slack around the ring so flames are not clipped
  private box: number;       // canvas css size
  private cx: number;
  private cy: number;
  private dpr = 1;

  private frac = 1;
  private urgency = 0;
  private running = false;
  private wanted = false;
  private level: MotionLevel;
  private offMotion: () => void;
  private t = 0;

  constructor(ringBox: number, ringRadius: number, pad = 46) {
    this.ring = ringRadius;
    this.pad = pad;
    this.box = ringBox + pad * 2;
    this.cx = this.box / 2;
    this.cy = this.box / 2;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fire-canvas';
    this.canvas.style.inset = `${-pad}px`;
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;

    this.level = motionLevel();
    this.offMotion = onMotionChange(lvl => {
      this.level = lvl;
      if (lvl === 'off') {
        this.running = false;
        this.parts.length = 0;
        this.ctx.clearRect(0, 0, this.box, this.box);
        this.canvas.style.opacity = '0';
      } else if (this.wanted) this.start();
    });

    this.resize();
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.box * this.dpr;
    this.canvas.height = this.box * this.dpr;
    this.canvas.style.width = `${this.box}px`;
    this.canvas.style.height = `${this.box}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setProgress(frac: number): void {
    this.frac = Math.max(0, Math.min(1, frac));
    this.urgency = this.frac <= 0.15 ? 1
      : this.frac <= 0.25 ? 0.6
      : this.frac <= 0.5 ? 0.28 : 0.08;
  }

  start(): void {
    this.wanted = true;
    if (this.running || this.level === 'off') return;
    this.running = true;
    this.canvas.style.opacity = '1';
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  /** Stop emitting but let the existing flame burn out rather than snapping off. */
  stop(): void { this.running = false; }

  clear(): void {
    this.running = false;
    this.wanted = false;
    this.parts.length = 0;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ctx.clearRect(0, 0, this.box, this.box);
    this.canvas.style.opacity = '0';
  }

  private headAngle(): number {
    return -Math.PI / 2 + TAU * this.frac;
  }

  private spawn(x: number, y: number, heat: number, ember: boolean): void {
    if (this.parts.length >= MAX_PARTICLES) return;
    const nx = (x - this.cx) / this.ring;
    const ny = (y - this.cy) / this.ring;
    const spread = ember ? 1.1 : 0.62;

    this.parts.push({
      x, y,
      vx: nx * (ember ? 0.55 : 0.3) + (Math.random() - 0.5) * spread,
      vy: ny * (ember ? 0.55 : 0.3) + (Math.random() - 0.5) * spread - (ember ? 0.5 : 0.3),
      life: 1,
      decay: ember ? 0.005 + Math.random() * 0.005 : 0.016 + Math.random() * 0.024,
      size: ember ? 1.0 + Math.random() * 1.1 : 4 + Math.random() * 7,
      heat,
      ember,
    });
  }

  private emit(): void {
    if (!this.running || this.frac <= 0) return;
    const head = this.headAngle();
    const calm = this.level === 'calm';

    // Calm still burns -- it just emits about a third as much and skips the shower,
    // so the effect is present and legible without being busy.
    const density = calm ? 0.34 : 1;

    // 1. the flame head -- hottest, where the fuse is actually burning
    const headCount = Math.max(2, Math.round((7 + this.urgency * 9) * density));
    for (let i = 0; i < headCount; i++) {
      const a = head + (Math.random() - 0.5) * 0.2;
      const r = this.ring + (Math.random() - 0.5) * 8;
      this.spawn(this.cx + Math.cos(a) * r, this.cy + Math.sin(a) * r,
        0.88 + Math.random() * 0.12, false);
    }

    // 2. smoulder along the surviving arc, hotter as it nears the head
    const arcCount = Math.max(1, Math.round((3 + this.urgency * 7) * density));
    for (let i = 0; i < arcCount; i++) {
      const t = Math.random();
      const a = -Math.PI / 2 + TAU * this.frac * t;
      const r = this.ring + (Math.random() - 0.5) * 6;
      const heat = 0.3 + t * 0.42 + this.urgency * 0.2;
      this.spawn(this.cx + Math.cos(a) * r, this.cy + Math.sin(a) * r, heat, false);
    }

    // 3. embers -- always a few, a shower once the clock turns threatening.
    //    Calm gets none: flying sparks are exactly the unpredictable motion to drop.
    const emberCount = calm ? 0
      : this.urgency >= 0.6 ? 2 : Math.random() < 0.55 ? 1 : 0;
    for (let i = 0; i < emberCount; i++) {
      const a = head + (Math.random() - 0.5) * 0.7;
      const r = this.ring + (Math.random() - 0.5) * 9;
      this.spawn(this.cx + Math.cos(a) * r, this.cy + Math.sin(a) * r, 0.9, true);
    }
  }

  /** Soft wide glow traced along the remaining arc — the bed the particles sit on. */
  private drawGlowBed(ctx: CanvasRenderingContext2D): void {
    if (this.frac <= 0) return;
    const [r, g, b] = heatColor(0.55 + this.urgency * 0.2);
    const pulse = this.level === 'calm' ? 1 : 0.82 + Math.sin(this.t / 220) * 0.18;

    ctx.save();
    ctx.lineCap = 'round';
    // two passes: a wide diffuse halo, then a tighter brighter core
    for (const [w, alpha] of [[26, 0.1], [13, 0.2]] as const) {
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha * pulse * (0.55 + this.urgency * 0.75)})`;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, this.ring, -Math.PI / 2, this.headAngle());
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Bloom at the burning head, so the hot point reads even against the bright stroke. */
  private drawHeadBloom(ctx: CanvasRenderingContext2D): void {
    if (this.frac <= 0) return;
    const a = this.headAngle();
    const x = this.cx + Math.cos(a) * this.ring;
    const y = this.cy + Math.sin(a) * this.ring;
    const flick = this.level === 'calm' ? 0.9 : 0.86 + Math.sin(this.t / 55) * 0.14;
    const rad = (23 + this.urgency * 15) * flick;

    // Kept deliberately translucent: an opaque core swallows the flame tongues that
    // spawn in the same place, and the point of the head is that it is made of them.
    const grd = ctx.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, `rgba(255,250,230,${0.30 * flick})`);
    grd.addColorStop(0.22, `rgba(255,206,120,${0.22 * flick})`);
    grd.addColorStop(0.55, `rgba(240,120,36,${0.12 * flick})`);
    grd.addColorStop(1, 'rgba(200,60,20,0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, TAU);
    ctx.fill();
  }

  private frame = (): void => {
    const ctx = this.ctx;
    this.t += 16;
    ctx.clearRect(0, 0, this.box, this.box);

    this.emit();
    ctx.globalCompositeOperation = 'lighter';

    this.drawGlowBed(ctx);

    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];

      p.life -= p.decay;
      if (p.life <= 0) { this.parts.splice(i, 1); continue; }

      // buoyancy plus turbulence; drag keeps particles from escaping the panel
      p.vy -= p.ember ? 0.024 : 0.016;
      p.vx += (Math.random() - 0.5) * (p.ember ? 0.06 : 0.11);
      p.vx *= 0.976;
      p.vy *= 0.976;
      p.x += p.vx;
      p.y += p.vy;

      const heat = p.heat * (p.ember ? p.life * 0.75 + 0.25 : p.life);
      const [r, g, b] = heatColor(heat);
      const alpha = p.ember ? p.life * 0.95 : p.life * p.life * 0.62;
      const rad = p.size * (p.ember ? 1 : 0.55 + p.life * 0.8);

      if (p.ember) {
        // a hard fill at this radius aliases into a square, so give it a halo
        const halo = rad * 3;
        const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, halo);
        grd.addColorStop(0, `rgba(255,248,222,${alpha})`);
        grd.addColorStop(0.26, `rgba(${r},${g},${b},${alpha * 0.9})`);
        grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(p.x, p.y, halo, 0, TAU);
        ctx.fill();
      } else {
        // soft-edged blob: a hard circle reads as a bubble, not flame
        const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
        grd.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
        grd.addColorStop(0.4, `rgba(${r},${g},${b},${alpha * 0.45})`);
        grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, TAU);
        ctx.fill();
      }
    }

    this.drawHeadBloom(ctx);
    ctx.globalCompositeOperation = 'source-over';

    if (this.running || this.parts.length > 0) {
      this.raf = requestAnimationFrame(this.frame);
    } else {
      this.raf = 0;
      this.canvas.style.opacity = '0';
    }
  };

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.parts.length = 0;
    this.offMotion();
  }
}
