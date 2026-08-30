import { escapeHtml } from './timerRing';
import { avatarHtml } from './avatar';
import { sfx } from '../audio/sfx';
import { openBugReport } from './reportBug';
import type { Account } from '../types';

/**
 * The site header: the brand on the left, and who you are on the right.
 *
 * Signed in, that corner is a chip -- avatar and name -- that opens the profile. Signed
 * out it is Log in and Sign up. It is the same corner either way, which is the point: the
 * answer to "am I signed in?" should be in one fixed place rather than somewhere that
 * moves depending on the answer.
 *
 * The room has its own header, crowded with controls that only exist during a game, so
 * this one belongs to the pages around it -- home, sign-in, profile.
 */

export interface AppBarOptions {
  /** Shown pressed, so the header says which of its own pages you are on. */
  active?: 'home' | 'profile';
}

export function renderAppBar(account: Account | null, opts: AppBarOptions = {}): string {
  const right = account
    ? `<a class="appbar-me${opts.active === 'profile' ? ' on' : ''}" href="#/profile"
          title="Your profile and games">
         ${avatarHtml(account.username, 'sm')}
         <span class="appbar-name">${escapeHtml(account.username)}</span>
       </a>`
    : `<a class="btn btn-sm btn-ghost" href="#/login">Log in</a>
       <a class="btn btn-sm btn-primary" href="#/signup">Sign up</a>`;

  return `
    <header class="appbar">
      <a class="appbar-brand" href="#/" title="Home">
        <span class="appbar-mark">♚</span>
        <b>Bolotnoye Logovo</b>
      </a>
      <div class="appbar-spacer"></div>
      ${account?.isAdmin ? `<a class="btn btn-sm btn-ghost" href="#/admin">Admin</a>` : ''}
      <button class="btn btn-sm btn-ghost appbar-bug" data-bug
              title="Report a problem">Report a bug</button>
      ${right}
    </header>`;
}

/** Wire the header's own clicks. Navigation is by href, so this is mostly the sound. */
export function bindAppBar(root: HTMLElement): void {
  root.querySelectorAll('.appbar a').forEach(a => {
    a.addEventListener('click', () => sfx.click());
  });
  root.querySelector('[data-bug]')?.addEventListener('click', () => openBugReport());
}
