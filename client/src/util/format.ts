/**
 * Formatting shared by pages, with nothing behind it.
 *
 * Deliberately free of the DOM: the admin metrics tab is a pure string renderer, and the
 * preview harness draws it from Node with no browser anywhere. A helper that reaches for
 * `window` cannot live here.
 */

/** "just now", "12m ago", "3h ago", then a date. */
export function timeAgo(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString(undefined,
    { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Escape text for interpolation into markup. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}
