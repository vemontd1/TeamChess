import { escapeHtml } from './timerRing';

/**
 * A generated avatar: initials on a colour derived from the name.
 *
 * No uploads, no storage, no default-avatar image to ship. The point of a picture here is
 * that a row of games is scannable and a header says whose account you are looking at,
 * and two letters on a stable colour do both. It is also the only kind of avatar that
 * cannot be blank, which matters when every account has just been created.
 *
 * The colour is a hash of the name rather than of the account id, so the same player is
 * the same colour everywhere they appear -- including in a game record written before
 * anyone had an account at all.
 */

/** Two letters at most: the initials of a separated name, else the first two characters. */
function initialsOf(name: string): string {
  const parts = name.split(/[\s_.-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  const one = parts[0] ?? name;
  return one.slice(0, 2).toUpperCase() || '?';
}

/** FNV-1a, for a hue that is stable across reloads and machines. */
function hueOf(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % 360;
}

export type AvatarSize = 'sm' | 'md' | 'lg';

/** The avatar as markup, for the templates that build their rows as strings. */
export function avatarHtml(name: string, size: AvatarSize = 'md'): string {
  const label = name || 'Player';
  return `<span class="avatar avatar-${size}" style="--avatar-h:${hueOf(label)}"
    aria-hidden="true">${escapeHtml(initialsOf(label))}</span>`;
}
