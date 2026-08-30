import { renderAppBar, bindAppBar } from './appbar';
import { escapeHtml } from './timerRing';
import { toast } from './widgets';
import { openGameViewer } from './gameViewer';
import { sfx } from '../audio/sfx';
import * as net from '../net/socket';
import type { Account, AdminOverview, BugReport, GameSummary } from '../types';

/**
 * The admin panel: what the app has actually gathered.
 *
 * Everything here is computed from the archive and the stores rather than from a separate
 * analytics stream, so there is nothing to keep in sync and nothing that can disagree with
 * the games themselves. The panel is a reader.
 *
 * Access is decided by the server on every call, from the session's account against
 * `ADMIN_USERS`. This page never asks whether it should be allowed to draw itself; it asks
 * for data and draws what comes back, so hiding the route would gain nothing and revealing
 * it costs nothing.
 */

function pct(n: number, total: number): string {
  return total > 0 ? `${Math.round((n / total) * 100)}%` : '0%';
}

function when(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString(undefined,
    { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function tallyRows(title: string, counts: Record<string, number>, total: number): string {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return '';
  return `<div class="adm-tally">
    <h3>${escapeHtml(title)}</h3>
    ${rows.map(([k, n]) => `<div class="adm-row">
      <span class="adm-key">${escapeHtml(k)}</span>
      <span class="adm-bar"><i style="width:${total > 0 ? (n / total) * 100 : 0}%"></i></span>
      <span class="adm-n">${n}</span>
      <span class="adm-pct">${pct(n, total)}</span>
    </div>`).join('')}
  </div>`;
}

function gameRow(g: GameSummary): string {
  return `<button type="button" class="adm-game" data-id="${escapeHtml(g.id)}">
    <span class="adm-game-who">${escapeHtml(g.white.join(', ') || '?')}
      <i>vs</i> ${escapeHtml(g.black.join(', ') || '?')}</span>
    <span class="adm-game-mode">${g.mode === 'cards' ? 'Cards' : 'Team'}</span>
    <span class="adm-game-plies">${g.plies} ply</span>
    <span class="adm-game-res">${escapeHtml(g.result)} · ${escapeHtml(g.reason)}</span>
    <span class="adm-game-when">${escapeHtml(when(g.finishedAt))}</span>
  </button>`;
}

function reportRow(r: BugReport): string {
  const c = r.context;
  const bits = [
    c.roomId ? `room ${c.roomId.toUpperCase()}` : null,
    c.mode ? (c.mode === 'cards' ? 'Cards' : 'Team') : null,
    c.status,
    typeof c.plies === 'number' ? `${c.plies} plies` : null,
    c.viewport,
    c.route,
  ].filter(Boolean) as string[];

  const shots = r.attachments ?? [];
  return `<article class="adm-report${r.resolved ? ' done' : ''}" data-id="${escapeHtml(r.id)}">
    <header>
      <span class="adm-rep-who">${escapeHtml(r.reporter)}</span>
      <span class="adm-rep-when">${escapeHtml(when(r.at))}</span>
      ${shots.length > 0
        ? `<span class="adm-rep-count">${shots.length} image${shots.length > 1 ? 's' : ''}</span>`
        : ''}
      <button class="btn btn-sm ${r.resolved ? 'btn-ghost' : ''}" data-act="toggle"
        title="${r.resolved ? 'Put this back on the list'
          : shots.length > 0
            ? 'Resolving deletes the screenshots on this report — it cannot be undone'
            : 'Mark this report done'}">
        ${r.resolved ? 'Reopen' : 'Mark done'}</button>
    </header>
    <p class="adm-rep-text">${escapeHtml(r.text)}</p>
    ${shots.length > 0 ? `<div class="adm-rep-shots">
      ${shots.map(a => `<button class="adm-shot" data-att="${escapeHtml(a.id)}"
          title="${escapeHtml(a.name)}">
          <span class="adm-shot-load">image</span>
        </button>`).join('')}
    </div>` : ''}
    <div class="adm-rep-ctx">${bits.map(b => `<span>${escapeHtml(b)}</span>`).join('')}</div>
    ${c.fen ? `<code class="adm-rep-fen">${escapeHtml(c.fen)}</code>` : ''}
    ${c.userAgent ? `<details class="adm-rep-ua"><summary>browser</summary>
      <code>${escapeHtml(c.userAgent)}</code></details>` : ''}
  </article>`;
}

/**
 * Screenshots are fetched one at a time, on demand.
 *
 * A page of reports would otherwise pull every image on every render, and they are the
 * only large thing here. The bytes come over the socket rather than from a URL, because a
 * URL would need the session in a query string.
 */
function wireShots(card: HTMLElement, reportId: string): void {
  card.querySelectorAll<HTMLButtonElement>('.adm-shot').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.loaded === '1') {
        const img = btn.querySelector('img');
        if (img) openLightbox(img.src);
        return;
      }
      btn.disabled = true;
      const att = await net.adminAttachment(reportId, btn.dataset.att!);
      btn.disabled = false;
      if (!att) {
        btn.textContent = 'gone';
        btn.classList.add('adm-shot-gone');
        btn.title = 'This screenshot was deleted when the report was resolved';
        return;
      }
      btn.dataset.loaded = '1';
      btn.innerHTML = `<img src="data:${att.mime};base64,${att.base64}" alt="">`;
    });
  });
}

/** Full size, over everything, dismissed by clicking anywhere. */
function openLightbox(src: string): void {
  const host = document.createElement('div');
  host.className = 'shot-lightbox';
  host.innerHTML = `<img src="${src}" alt="">`;
  host.addEventListener('click', () => host.remove());
  document.body.appendChild(host);
}

export function renderAdmin(root: HTMLElement, account: Account): () => void {
  let live = true;
  let overview: AdminOverview | null = null;
  let reports: BugReport[] = [];
  let tab: 'stats' | 'reports' = 'reports';

  const draw = (loading: boolean): void => {
    const g = overview?.games;
    const total = g?.total ?? 0;
    const open = reports.filter(r => !r.resolved).length;

    root.innerHTML = `
      ${renderAppBar(account)}
      <div class="page page-wide">
        <section class="panel edge sheen adm-head">
          <div>
            <h1>Admin</h1>
            <p>Everything the app has gathered, read straight off the archive.</p>
          </div>
          <div class="adm-cards">
            <div class="adm-card"><b>${total}</b><span>games</span></div>
            <div class="adm-card"><b>${g?.last7 ?? 0}</b><span>last 7 days</span></div>
            <div class="adm-card"><b>${overview?.accounts ?? 0}</b><span>accounts</span></div>
            <div class="adm-card"><b>${overview?.rooms.live ?? 0}</b><span>rooms live</span></div>
            <div class="adm-card ${open > 0 ? 'adm-card-hot' : ''}">
              <b>${open}</b><span>open reports</span></div>
          </div>
        </section>

        <div class="adm-tabs">
          <button class="adm-tab${tab === 'reports' ? ' on' : ''}" data-tab="reports">
            Reports${open > 0 ? ` (${open})` : ''}</button>
          <button class="adm-tab${tab === 'stats' ? ' on' : ''}" data-tab="stats">
            Stats &amp; setups</button>
        </div>

        ${loading ? '<section class="panel edge"><div class="games-loading">Loading…</div></section>' : ''}

        ${!loading && tab === 'reports' ? `
        <section class="panel edge">
          <div class="panel-head"><span class="panel-title">Bug reports</span>
            <span class="games-count">${reports.length} total</span></div>
          ${reports.length === 0
            ? '<div class="games-empty"><p>No reports yet.</p></div>'
            : `<div class="adm-reports">${reports.map(reportRow).join('')}</div>`}
        </section>` : ''}

        ${!loading && tab === 'stats' && overview ? `
        <section class="panel edge">
          <div class="panel-head"><span class="panel-title">Games</span>
            <span class="games-count">${overview.games.avgPlies} plies on average</span></div>
          <div class="adm-grid">
            ${tallyRows('By mode', overview.games.byMode, total)}
            ${tallyRows('By result', overview.games.byResult, total)}
            ${tallyRows('How they ended', overview.games.byReason, total)}
          </div>
        </section>

        <section class="panel edge">
          <div class="panel-head"><span class="panel-title">Setups people choose</span></div>
          <div class="adm-tally adm-setups">
            ${overview.setups.map(sx => `<div class="adm-row">
              <span class="adm-key">${escapeHtml(sx.label)}</span>
              <span class="adm-bar"><i style="width:${(sx.count / total) * 100}%"></i></span>
              <span class="adm-n">${sx.count}</span>
              <span class="adm-pct">${pct(sx.count, total)}</span>
            </div>`).join('') || '<div class="games-empty"><p>No games yet.</p></div>'}
          </div>
        </section>

        <section class="panel edge">
          <div class="panel-head"><span class="panel-title">Recent games</span></div>
          ${overview.recent.length === 0
            ? '<div class="games-empty"><p>No games yet.</p></div>'
            : `<div class="adm-games">${overview.recent.map(gameRow).join('')}</div>`}
        </section>` : ''}
      </div>`;

    bindAppBar(root);

    root.querySelectorAll<HTMLButtonElement>('.adm-tab').forEach(b => {
      b.addEventListener('click', () => {
        tab = b.dataset.tab as 'stats' | 'reports';
        sfx.click();
        draw(false);
      });
    });

    root.querySelectorAll<HTMLButtonElement>('.adm-game').forEach(b => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        const game = await net.fetchGame(b.dataset.id!);
        b.disabled = false;
        if (!game) { toast('That game is no longer stored', 'danger'); return; }
        openGameViewer(game);
      });
    });

    root.querySelectorAll<HTMLElement>('.adm-report').forEach(card => {
      const id = card.dataset.id!;
      wireShots(card, id);
      card.querySelector('[data-act="toggle"]')!.addEventListener('click', async () => {
        const now = reports.find(r => r.id === id);
        // Resolving throws the screenshots away and reopening cannot bring them back, so
        // it asks once rather than being quietly destructive.
        if (!now?.resolved && (now?.attachments?.length ?? 0) > 0) {
          const n = now!.attachments!.length;
          if (!confirm(`Mark this done? The ${n} screenshot${n > 1 ? 's' : ''} on it `
            + 'will be deleted, and reopening will not bring them back.')) return;
        }
        const updated = await net.adminResolveReport(id, !(now?.resolved ?? false));
        if (!updated) { toast('Could not update that report', 'danger'); return; }
        reports = reports.map(r => (r.id === id ? updated : r));
        sfx.click();
        draw(false);
      });
    });
  };

  draw(true);

  void Promise.all([net.adminOverview(), net.adminReports(200)])
    .then(([ov, reps]) => {
      if (!live) return;
      if (!ov && !reps) {
        // The server decides; if it says no, say so plainly rather than drawing an
        // empty panel that looks broken.
        root.innerHTML = `${renderAppBar(account)}
          <div class="page page-narrow">
            <section class="panel edge"><div class="games-empty">
              <div class="games-empty-mark">⌘</div>
              <p>This account is not an administrator.</p>
              <a class="btn btn-primary" href="#/">Back to the game</a>
            </div></section>
          </div>`;
        bindAppBar(root);
        return;
      }
      overview = ov;
      reports = reps ?? [];
      draw(false);
    })
    .catch(() => { if (live) draw(false); });

  return () => { live = false; };
}
