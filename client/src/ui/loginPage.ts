import { renderAppBar, bindAppBar } from './appbar';
import { sfx } from '../audio/sfx';
import * as net from '../net/socket';
import { setState } from '../state/store';
import type { Account } from '../types';

/**
 * Sign in, or create an account. A page of its own rather than a panel on the home
 * screen: it is a thing you go and do, and putting it under the room controls made it
 * read as one more option for setting up a game.
 *
 * The two modes are one page with one field set, because the difference between them is a
 * heading and a verb, and a player who followed the wrong link should not have to go
 * anywhere to fix it.
 */

const RULES = 'Usernames are 3–24 characters — letters, numbers, dashes and underscores. '
  + 'Passwords need at least 8 characters.';

export function renderLogin(root: HTMLElement, mode: 'login' | 'signup'): () => void {
  const registering = mode === 'signup';

  root.innerHTML = `
    ${renderAppBar(null)}
    <div class="page page-narrow">
      <section class="panel edge sheen auth-card">
        <div class="auth-head">
          <div class="auth-mark">♚</div>
          <h1>${registering ? 'Create an account' : 'Welcome back'}</h1>
          <p>${registering
            ? 'An account is what a game record belongs to — your finished games follow it '
              + 'to any browser or device.'
            : 'Sign in to pick your history back up.'}</p>
        </div>

        <div class="panel-body stack auth-form">
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
          ${registering ? `<div class="auth-rules">${RULES}</div>` : ''}

          <button class="btn btn-primary btn-lg" id="au-go">
            <span>${registering ? 'Create account' : 'Log in'}</span>
            <span class="btn-arrow">→</span>
          </button>
        </div>

        <div class="auth-foot">
          ${registering
            ? `Already have one? <a href="#/login">Log in</a>`
            : `No account yet? <a href="#/signup">Create one</a>`}
          <span class="auth-sep">·</span>
          <a href="#/">Play as a guest</a>
        </div>
      </section>

      <p class="auth-note">Nothing here gates the game. A guest can create a room, take a
        seat and play a whole match — an account is only what a record is kept against.</p>
    </div>`;

  bindAppBar(root);

  const user = root.querySelector<HTMLInputElement>('#au-user')!;
  const pass = root.querySelector<HTMLInputElement>('#au-pass')!;
  const err = root.querySelector<HTMLElement>('#au-err')!;
  const go = root.querySelector<HTMLButtonElement>('#au-go')!;
  let busy = false;

  const fail = (msg: string): void => {
    err.textContent = msg;
    err.hidden = false;
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    err.hidden = true;
    for (const el of [user, pass, go]) el.disabled = true;

    const res = registering
      ? await net.registerAccount(user.value.trim(), pass.value)
      : await net.loginAccount(user.value.trim(), pass.value);

    busy = false;
    for (const el of [user, pass, go]) el.disabled = false;

    if (!res.ok || !res.account) {
      fail(res.error ?? 'That did not work. Try again.');
      pass.focus();
      pass.select();
      return;
    }

    sfx.start();
    setState({ account: res.account as Account, profile: null });
    // Straight to the profile: it is the thing the account is for, and landing on an
    // empty history explains what will fill it better than any copy on this page could.
    location.hash = '#/profile';
  };

  go.addEventListener('click', () => void submit());
  for (const el of [user, pass]) {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') void submit(); });
  }
  user.focus();

  return () => { /* nothing to tear down: no timers, no sockets held */ };
}
