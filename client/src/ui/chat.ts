import { escapeHtml } from './timerRing';
import type { ChatMessage, ChatChannel } from '../types';

/**
 * Team chat.
 *
 * The panel is built once and only ever appended to. Re-rendering it from state on every
 * broadcast -- which is how the rest of this UI works -- would wipe whatever the player
 * was halfway through typing, several times a minute.
 *
 * What reaches this panel is decided by the server: your own team, or the spectator
 * channel. Nothing here filters, because nothing here is trusted to.
 */

const QUICK = ['Good move', 'Careful', 'Trade?', 'Take it', 'Sorry'];

export interface ChatHandlers {
  onSend: (text: string) => void;
}

const CHANNEL_LABEL: Record<ChatChannel, string> = {
  white: 'Team White',
  black: 'Team Black',
  spectator: 'Spectators',
};

export class ChatPanel {
  readonly el: HTMLElement;
  private log: HTMLElement;
  private tag: HTMLElement;
  private input: HTMLInputElement;
  private send: HTMLButtonElement;
  private quick: HTMLElement;
  private handlers: ChatHandlers;

  private rendered: ChatMessage[] = [];
  private youName = '';

  constructor(handlers: ChatHandlers) {
    this.handlers = handlers;
    this.el = document.createElement('section');
    this.el.className = 'panel edge chat';
    this.el.innerHTML = `
      <div class="panel-head">
        <span class="panel-title">Team chat</span>
        <span class="chat-tag" id="chat-tag">Spectators</span>
      </div>
      <div class="chat-log" id="chat-log" role="log" aria-live="polite"
           aria-label="Team chat messages"></div>
      <div class="chat-quick" id="chat-quick">
        ${QUICK.map(q =>
          `<button class="chip" type="button" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`
        ).join('')}
      </div>
      <form class="chat-form" id="chat-form" autocomplete="off">
        <input class="input chat-input" id="chat-input" maxlength="240"
               placeholder="Message your team…" aria-label="Message your team">
        <button class="btn btn-sm btn-primary" type="submit" id="chat-send">Send</button>
      </form>
      <div class="chat-hint">
        Right-click a square — or press <b>X</b> — to mark it for your team.
      </div>`;

    this.log = this.el.querySelector('#chat-log')!;
    this.tag = this.el.querySelector('#chat-tag')!;
    this.input = this.el.querySelector('#chat-input')!;
    this.send = this.el.querySelector('#chat-send')!;
    this.quick = this.el.querySelector('#chat-quick')!;

    this.el.querySelector('#chat-form')!.addEventListener('submit', e => {
      e.preventDefault();
      this.submit(this.input.value);
      this.input.value = '';
    });

    this.quick.querySelectorAll<HTMLButtonElement>('[data-q]').forEach(b => {
      b.addEventListener('click', () => this.submit(b.dataset.q ?? ''));
    });

    this.setMessages([], '');
  }

  private submit(raw: string): void {
    const text = raw.trim();
    if (!text) return;
    this.handlers.onSend(text);
  }

  setChannel(channel: ChatChannel, seated: boolean): void {
    this.tag.textContent = CHANNEL_LABEL[channel];
    this.tag.className = `chat-tag chat-tag-${channel}`;
    this.el.classList.toggle('chat-spectating', !seated);
    this.input.placeholder = seated
      ? 'Message your team…'
      : 'Message other spectators…';
  }

  setEnabled(connected: boolean): void {
    this.input.disabled = !connected;
    this.send.disabled = !connected;
    this.quick.querySelectorAll('button').forEach(b => { b.disabled = !connected; });
  }

  /** Append what is new; rebuild only when the log is not an extension of what is shown. */
  setMessages(msgs: ChatMessage[], youName: string): void {
    this.youName = youName;
    const isExtension = msgs.length >= this.rendered.length
      && (this.rendered.length === 0 || msgs[0]?.id === this.rendered[0]?.id);

    if (!isExtension) {
      // A backlog arriving on join is not news. Left live, the region would read the whole
      // history aloud the moment the player enters the room.
      this.log.setAttribute('aria-live', 'off');
      setTimeout(() => this.log.setAttribute('aria-live', 'polite'), 0);
      this.log.innerHTML = '';
      this.rendered = [];
    }

    const nearBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
    for (const m of msgs.slice(this.rendered.length)) this.append(m);
    this.rendered = msgs.slice();

    if (this.rendered.length === 0) {
      this.log.innerHTML = `<div class="empty-note">Only your team can read this</div>`;
    } else if (nearBottom) {
      this.log.scrollTop = this.log.scrollHeight;
    }
  }

  private append(m: ChatMessage): void {
    const empty = this.log.querySelector('.empty-note');
    if (empty) empty.remove();
    const row = document.createElement('div');
    row.className = `chat-msg ${m.name === this.youName ? 'chat-mine' : ''}`;
    row.innerHTML = `<span class="chat-who">${escapeHtml(m.name)}</span>` +
      `<span class="chat-text">${escapeHtml(m.text)}</span>`;
    this.log.appendChild(row);
  }
}
