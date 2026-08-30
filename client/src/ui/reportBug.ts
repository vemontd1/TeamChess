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
 */

const MAX = 2000;

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

export function openBugReport(): void {
  const ctx = context();
  const { host, close } = modal(`
    <h2>Report a problem</h2>
    <p>What went wrong? Anything you noticed is useful — what you expected, what
       happened instead.</p>
    <div class="field tfield report-field">
      <textarea id="rp-text" maxlength="${MAX}" rows="5"
        placeholder="The timer stopped and nobody won…"></textarea>
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

  const submit = async (): Promise<void> => {
    const body = text.value.trim();
    if (!body) {
      err.textContent = 'Say a little about what went wrong.';
      err.hidden = false;
      text.focus();
      return;
    }
    send.disabled = true;
    const res = await net.sendReport(body, ctx);
    send.disabled = false;
    if (!res.ok) {
      err.textContent = res.error ?? 'That did not send. Try again.';
      err.hidden = false;
      return;
    }
    close();
    sfx.click();
    toast('Report sent — thank you');
  };

  send.addEventListener('click', () => void submit());
  host.querySelector('#rp-cancel')!.addEventListener('click', close);
  host.addEventListener('click', e => { if (e.target === host) close(); });
  // Enter is a newline in a textarea, so the shortcut is the usual modifier pair.
  text.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
  });
  text.focus();
}
