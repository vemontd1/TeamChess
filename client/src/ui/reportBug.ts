import { modal, toast } from './widgets';
import { escapeHtml } from './timerRing';
import { sfx } from '../audio/sfx';
import * as net from '../net/socket';
import { getState } from '../state/store';

/**
 * File a bug from wherever you are standing.
 *
 * The alternative is a person remembering, and a problem seen mid-game is described
 * accurately for about thirty seconds before it becomes "something was wrong with the
 * cards". So the report takes the room, the game, the mode, the position and the browser
 * with it, and the only thing the reporter has to supply is the sentence.
 *
 * What gets attached is shown before it is sent, because a report that quietly collects
 * context is a report people stop trusting.
 *
 * Screenshots are the other half. Most bugs worth reporting are visible, and describing a
 * layout in prose is exactly the thing people give up on. They are downscaled in the
 * browser before they are sent, and **deleted the moment the report is resolved** -- a
 * screenshot is evidence for a bug, and once the bug is fixed it is a picture of somebody's
 * screen that nobody has a reason to keep.
 */

const MAX = 2000;
const MAX_SHOTS = 3;

/** Long edge, in pixels. A phone screenshot is 1179 wide; this keeps it readable. */
const MAX_EDGE = 1400;
const QUALITY = 0.78;

interface Shot { name: string; dataUrl: string; bytes: number }

/** Everything worth knowing that the client can see without being asked. */
function context(): Record<string, unknown> {
  const s = getState();
  const room = s.room;
  return {
    route: location.hash || '#/',
    roomId: room?.id ?? null,
    mode: room?.config.mode ?? null,
    gameSeq: room?.gameSeq ?? null,
    status: room?.status ?? null,
    fen: room?.fen ?? null,
    plies: room?.history.length ?? null,
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  };
}

function summarise(c: Record<string, unknown>): string {
  const bits: string[] = [];
  if (c.roomId) bits.push(`room ${String(c.roomId).toUpperCase()}`);
  if (c.mode) bits.push(c.mode === 'cards' ? 'Chess Cards' : 'Team Chess');
  if (c.status) bits.push(String(c.status));
  if (typeof c.plies === 'number') bits.push(`${c.plies} plies`);
  bits.push(String(c.viewport));
  return bits.join(' · ');
}

function kb(bytes: number): string {
  return bytes > 900_000 ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Shrink an image to something worth sending.
 *
 * A raw phone screenshot is several megabytes of PNG; the same picture at 1400px as JPEG
 * is a couple of hundred kilobytes and just as readable for a bug. Done here rather than
 * on the server so the bytes never travel in the first place.
 */
function downscale(file: File): Promise<Shot | null> {
  return new Promise(resolve => {
    if (!file.type.startsWith('image/')) { resolve(null); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(null); return; }
      ctx.drawImage(img, 0, 0, w, h);

      // JPEG for photographs of a screen; the interface is dark, so the artefacts that
      // would show on flat colour are not where anyone is looking.
      const dataUrl = canvas.toDataURL('image/jpeg', QUALITY);
      resolve({
        name: file.name || 'screenshot.jpg',
        dataUrl,
        bytes: Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75),
      });
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

export function openBugReport(): void {
  const ctx = context();
  const shots: Shot[] = [];

  const { host, close } = modal(`
    <h2>Report a problem</h2>
    <p>What went wrong? Anything you noticed is useful — what you expected, what
       happened instead.</p>
    <div class="field tfield report-field">
      <textarea id="rp-text" maxlength="${MAX}" rows="5"
        placeholder="The timer stopped and nobody won…"></textarea>
    </div>

    <div class="report-shots">
      <div class="report-shots-head">
        <span class="report-ctx-label">Screenshots (optional)</span>
        <button class="btn btn-sm btn-ghost" id="rp-add">Add image</button>
      </div>
      <p class="report-shots-hint">Paste with <b>Ctrl/Cmd&nbsp;+&nbsp;V</b>, drop a file
        here, or use the button. Deleted when the report is resolved.</p>
      <div class="report-thumbs" id="rp-thumbs"></div>
      <input type="file" id="rp-file" accept="image/*" multiple hidden>
    </div>

    <div class="report-ctx">
      <span class="report-ctx-label">Sent with this report</span>
      <code>${escapeHtml(summarise(ctx))}</code>
    </div>
    <div class="report-err" id="rp-err" hidden></div>
    <div class="btn-row" style="justify-content:center;margin-top:18px">
      <button class="btn btn-primary" id="rp-send">Send report</button>
      <button class="btn btn-ghost" id="rp-cancel">Cancel</button>
    </div>`);

  const text = host.querySelector<HTMLTextAreaElement>('#rp-text')!;
  const err = host.querySelector<HTMLElement>('#rp-err')!;
  const send = host.querySelector<HTMLButtonElement>('#rp-send')!;
  const thumbs = host.querySelector<HTMLElement>('#rp-thumbs')!;
  const fileInput = host.querySelector<HTMLInputElement>('#rp-file')!;
  const dialog = host.querySelector<HTMLElement>('.modal')!;

  const fail = (msg: string): void => { err.textContent = msg; err.hidden = false; };

  const paintThumbs = (): void => {
    thumbs.innerHTML = shots.map((s, i) => `
      <figure class="report-thumb">
        <img src="${s.dataUrl}" alt="${escapeHtml(s.name)}">
        <figcaption>${kb(s.bytes)}</figcaption>
        <button class="report-thumb-x" data-i="${i}"
                aria-label="Remove ${escapeHtml(s.name)}">✕</button>
      </figure>`).join('');
    thumbs.querySelectorAll<HTMLButtonElement>('.report-thumb-x').forEach(b => {
      b.addEventListener('click', () => {
        shots.splice(Number(b.dataset.i), 1);
        paintThumbs();
      });
    });
    host.querySelector<HTMLButtonElement>('#rp-add')!.disabled = shots.length >= MAX_SHOTS;
  };

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    for (const file of Array.from(files)) {
      if (shots.length >= MAX_SHOTS) { fail(`Up to ${MAX_SHOTS} images.`); break; }
      const shot = await downscale(file);
      if (!shot) { fail('That file is not an image I can read.'); continue; }
      shots.push(shot);
    }
    paintThumbs();
  };

  host.querySelector('#rp-add')!.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files) void addFiles(fileInput.files);
    fileInput.value = '';
  });

  // Pasting is how people actually attach a screenshot: the clipboard is where it already
  // is, one key after taking it.
  const onPaste = (e: ClipboardEvent): void => {
    const items = Array.from(e.clipboardData?.items ?? [])
      .filter(i => i.type.startsWith('image/'));
    if (items.length === 0) return;
    e.preventDefault();
    const files = items.map(i => i.getAsFile()).filter((f): f is File => f != null);
    if (files.length > 0) void addFiles(files);
  };
  host.addEventListener('paste', onPaste as EventListener);

  for (const kind of ['dragover', 'drop'] as const) {
    dialog.addEventListener(kind, e => {
      e.preventDefault();
      dialog.classList.toggle('report-dropping', kind === 'dragover');
      if (kind === 'drop') {
        const files = (e as DragEvent).dataTransfer?.files;
        if (files?.length) void addFiles(files);
      }
    });
  }
  dialog.addEventListener('dragleave', () => dialog.classList.remove('report-dropping'));

  const submit = async (): Promise<void> => {
    const body = text.value.trim();
    if (!body) {
      fail('Say a little about what went wrong.');
      text.focus();
      return;
    }
    send.disabled = true;
    send.textContent = shots.length > 0 ? 'Sending images…' : 'Sending…';

    const res = await net.sendReport(body, ctx,
      shots.map(s => ({ name: s.name, dataUrl: s.dataUrl })));

    send.disabled = false;
    send.textContent = 'Send report';
    if (!res.ok) {
      fail(res.error ?? 'That did not send. Try again.');
      return;
    }
    close();
    sfx.click();
    toast(shots.length > 0 ? 'Report and screenshots sent — thank you'
      : 'Report sent — thank you');
  };

  send.addEventListener('click', () => void submit());
  host.querySelector('#rp-cancel')!.addEventListener('click', close);
  host.addEventListener('click', e => { if (e.target === host) close(); });
  // Enter is a newline in a textarea, so the shortcut is the usual modifier pair.
  text.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
  });
  text.focus();
  paintThumbs();
}
