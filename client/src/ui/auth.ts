import { escapeHtml } from './timerRing';
import { sfx } from '../audio/sfx';
import * as net from '../net/socket';
import type { Account } from '../types';

/**
 * Register, or sign in.
 *
 * One panel with two modes rather than two screens, because the difference between them
 * is a single line of copy and a player who picked the wrong one should not have to
 * navigate anywhere to fix it.
 *
 * The account is what a game record belongs to. Playing does not require one -- a guest
 * can create a room, take a seat and play a full game -- so this never blocks the way in.
 * What it buys is the record, and the panel says exactly that instead of implying the
 * game is behind a sign-up.
 */

export interface AuthHandlers {
  /** Signed in or registered; the caller reloads whatever depends on identity. */
  onChange: (account: Account | null) => void;
}

const RULES = 'Usernames are 3–24 characters. Passwords need at least 8.';

export class AuthPanel {
  readonly el: HTMLElement;
  private mode: 'login' | 'register' = 'login';
  private account: Account | null = null;
  private busy = false;
  private handlers: AuthHandlers;

  constructor(handlers: AuthHandlers) {
    this.handlers = handlers;
    this.el = document.createElement('section');
    this.el.className = 'panel edge auth-panel';
    this.render();
  }

  setAccount(account: Account | null): void {
    this.account = account;
    this.render();
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const user = this.el.querySelector<HTMLInputElement>('#au-user')!.value.trim();
    const pass = this.el.querySelector<HTMLInputElement>('#au-pass')!.value;

    this.busy = true;
    this.paintError('');
    this.setDisabled(true);

    const res = this.mode === 'register'
      ? await net.registerAccount(user, pass)
      : await net.loginAccount(user, pass);

    this.busy = false;
    this.setDisabled(false);

    if (!res.ok || !res.account) {
      this.paintError(res.error ?? 'That did not work. Try again.');
      this.el.querySelector<HTMLInputElement>('#au-pass')!.focus();
      return;
    }
    sfx.click();
    this.account = res.account;
    this.render();
    this.handlers.onChange(res.account);
  }

  private setDisabled(on: boolean): void {
    this.el.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')
      .forEach(b => { b.disabled = on; });
  }

  private paintError(msg: string): void {
    const el = this.el.querySelector<HTMLElement>('#au-err');
    if (el) { el.textContent = msg; el.hidden = !msg; }
  }

  private render(): void {
    if (this.account) {
      this.el.innerHTML = `
        <div class="panel-body auth-in">
          <div>
            <div class="auth-who">Signed in as <b>${escapeHtml(this.account.username)}</b></div>
            <div class="auth-sub">Your finished games are being kept.</div>
          </div>
          <button class="btn btn-sm btn-ghost" id="au-out">Sign out</button>
        </div>`;
      this.el.querySelector('#au-out')!.addEventListener('click', () => {
        net.logoutAccount();
        this.account = null;
        this.render();
        this.handlers.onChange(null);
      });
      return;
    }

    const registering = this.mode === 'register';
    this.el.innerHTML = `
      <div class="panel-head">
        <span class="panel-title">${registering ? 'Create an account' : 'Sign in'}</span>
      </div>
      <div class="panel-body stack auth-form">
        <p class="auth-why">Play as a guest if you like — nothing here gates the game.
          An account is what a game record belongs to, so it is the one thing that
          cannot work without it.</p>
        <div class="field tfield">
          <label class="label" for="au-user">Username</label>
          <input id="au-user" maxlength="24" autocomplete="username" autocapitalize="off"
                 spellcheck="false" placeholder="username">
        </div>
        <div class="field tfield">
          <label class="label" for="au-pass">Password</label>
          <input id="au-pass" type="password" maxlength="200"
                 autocomplete="${registering ? 'new-password' : 'current-password'}"
                 placeholder="password">
        </div>
        <div class="auth-err" id="au-err" hidden></div>
        <div class="auth-rules">${RULES}</div>
        <button class="btn btn-primary" id="au-go">
          ${registering ? 'Create account' : 'Sign in'}</button>
        <button class="btn btn-sm btn-ghost" id="au-swap">
          ${registering ? 'I already have an account' : 'Create one instead'}</button>
      </div>`;

    this.el.querySelector('#au-go')!.addEventListener('click', () => void this.submit());
    this.el.querySelector('#au-swap')!.addEventListener('click', () => {
      this.mode = registering ? 'login' : 'register';
      this.render();
      this.el.querySelector<HTMLInputElement>('#au-user')!.focus();
      sfx.click();
    });
    for (const id of ['#au-user', '#au-pass']) {
      this.el.querySelector<HTMLInputElement>(id)!.addEventListener('keydown', e => {
        if (e.key === 'Enter') void this.submit();
      });
    }
  }
}
