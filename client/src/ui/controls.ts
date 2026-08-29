/** Framework-free form controls: a stepped slider and a segmented control. */

export interface SliderStop { value: number; label: string; }

export interface SliderOpts {
  stops: SliderStop[];
  index: number;
  title: string;
  /** Rendered small and uppercase next to the big value. */
  unit?: (s: SliderStop) => string;
  onChange?: (stop: SliderStop, index: number) => void;
}

/**
 * A slider over discrete stops rather than a continuous range.
 *
 * Move timers want 10/15/20/30/45/60/90/120s -- unevenly spaced values that a linear
 * range input cannot express. Sliding over an index and mapping to the stop keeps every
 * position meaningful and every stop reachable.
 */
export class Slider {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private valueEl: HTMLElement;
  private opts: SliderOpts;
  private idx: number;

  constructor(opts: SliderOpts) {
    this.opts = opts;
    this.idx = opts.index;

    this.el = document.createElement('div');
    this.el.className = 'slider';
    this.el.innerHTML = `
      <div class="slider-head">
        <span class="label">${opts.title}</span>
        <span class="slider-value"></span>
      </div>
      <div class="slider-track">
        <input type="range" min="0" max="${opts.stops.length - 1}" step="1"
               value="${this.idx}" aria-label="${opts.title}">
      </div>
      <div class="slider-ticks">
        ${opts.stops.map(s => `<span class="slider-tick">${s.label}</span>`).join('')}
      </div>`;

    this.input = this.el.querySelector('input')!;
    this.valueEl = this.el.querySelector('.slider-value')!;

    this.input.addEventListener('input', () => {
      const next = Number(this.input.value);
      if (next !== this.idx) {
        this.idx = next;
        this.paint(true);
        this.opts.onChange?.(this.stop, this.idx);
      }
    });

    this.paint(false);
  }

  get stop(): SliderStop { return this.opts.stops[this.idx]; }
  get value(): number { return this.stop.value; }

  private paint(bump: boolean): void {
    const max = this.opts.stops.length - 1;
    const pct = max === 0 ? 100 : (this.idx / max) * 100;
    this.el.style.setProperty('--pct', `${pct}%`);

    const s = this.stop;
    const unit = this.opts.unit?.(s) ?? '';
    this.valueEl.innerHTML = `${s.label}${unit ? `<small>${unit}</small>` : ''}`;

    this.el.querySelectorAll('.slider-tick').forEach((t, i) => {
      t.classList.toggle('on', i === this.idx);
    });

    // a short scale pulse on the readout so a drag feels physically connected
    if (bump) {
      this.el.classList.add('bumped');
      setTimeout(() => this.el.classList.remove('bumped'), 140);
    }
  }
}

export interface SegmentOpts {
  options: { value: string; label: string }[];
  value: string;
  onChange?: (value: string) => void;
}

/** Segmented control with a pill that glides between options. */
export class Segmented {
  readonly el: HTMLElement;
  private glide: HTMLElement;
  private opts: SegmentOpts;
  private current: string;

  constructor(opts: SegmentOpts) {
    this.opts = opts;
    this.current = opts.value;

    this.el = document.createElement('div');
    this.el.className = 'seg';
    this.el.innerHTML = `
      <span class="seg-glide"></span>
      ${opts.options.map(o =>
        `<button type="button" class="seg-btn${o.value === this.current ? ' on' : ''}"
                 data-v="${o.value}">${o.label}</button>`).join('')}`;

    this.glide = this.el.querySelector('.seg-glide')!;

    this.el.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach(b => {
      b.addEventListener('click', () => this.set(b.dataset.v!));
    });

    // the pill is positioned from measured geometry, so it must wait for layout
    requestAnimationFrame(() => this.move());
    window.addEventListener('resize', this.move);
  }

  get value(): string { return this.current; }

  set(v: string): void {
    if (v === this.current) return;
    this.current = v;
    this.el.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach(b => {
      b.classList.toggle('on', b.dataset.v === v);
    });
    this.move();
    this.opts.onChange?.(v);
  }

  private move = (): void => {
    const active = this.el.querySelector<HTMLElement>('.seg-btn.on');
    if (!active) return;
    this.glide.style.width = `${active.offsetWidth}px`;
    this.glide.style.transform = `translateX(${active.offsetLeft - 3}px)`;
  };

  destroy(): void { window.removeEventListener('resize', this.move); }
}

/** Labelled toggle with an optional hint line. */
export function toggle(id: string, title: string, hint: string, on: boolean): string {
  return `
    <label class="toggle">
      <input type="checkbox" id="${id}"${on ? ' checked' : ''}>
      <span class="toggle-track"></span>
      <span class="toggle-text">
        <span class="toggle-title">${title}</span>
        <span class="toggle-hint">${hint}</span>
      </span>
    </label>`;
}
