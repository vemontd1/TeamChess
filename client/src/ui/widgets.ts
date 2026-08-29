import { capturedInfo } from '../util/chessUtil';
import { pieceSvg, type PieceType, type PieceCode } from '../board/pieces';
import { escapeHtml } from './timerRing';
import type { RoomState, HistoryEntry, TeamView, SeatView } from '../types';

// ---------- captured tray ----------

export function renderTray(el: HTMLElement, fen: string): void {
  const info = capturedInfo(fen);
  const strip = (list: { type: string; count: number }[], color: 'w' | 'b'): string =>
    list.map(c => Array.from({ length: c.count }, () =>
      `<span class="tray-pc">${pieceSvg(`${color}${c.type as PieceType}` as PieceCode)}</span>`
    ).join('')).join('');

  const adv = info.advantage;
  el.innerHTML = `
    <div class="tray-side">${strip(info.whiteCaptured, 'b')}</div>
    ${adv !== 0 ? `<span class="tray-adv">${adv > 0 ? '+' : ''}${adv}</span>` : ''}
    <div class="tray-side right">${strip(info.blackCaptured, 'w')}</div>`;
}

// ---------- move list ----------

export function renderMoves(el: HTMLElement, history: HistoryEntry[]): void {
  if (history.length === 0) {
    el.innerHTML = `<div class="empty-note">No moves yet</div>`;
    return;
  }

  // pair plies into numbered full moves
  const rows: string[] = [];
  for (let i = 0; i < history.length; i += 2) {
    const w = history[i];
    const b = history[i + 1];
    const cell = (e: HistoryEntry | undefined): string => {
      if (!e) return '<span></span>';
      const mark = e.auto ? '<span class="move-auto" title="Forced by the clock">⏱</span>'
        : e.bot ? '<span class="move-bot" title="Played by a bot">◆</span>' : '';
      return `<span><span class="move-san ${e.color === 'white' ? 'w' : 'b'}">${escapeHtml(e.san)}</span>
        ${mark}<span class="move-by">${escapeHtml(e.playerName)}</span></span>`;
    };
    const latest = i + 2 >= history.length;
    rows.push(`<div class="move-row ${latest ? 'latest' : ''}">
      <span class="move-no">${i / 2 + 1}.</span>
      <span style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        ${cell(w)}${cell(b)}
      </span>
    </div>`);
  }
  el.innerHTML = rows.join('');
  el.scrollTop = el.scrollHeight;
}

// ---------- stats ----------

function fmtAvg(ms: number, moves: number): string {
  if (moves === 0) return '—';
  const s = ms / moves / 1000;
  return s >= 10 ? `${s.toFixed(0)}s` : `${s.toFixed(1)}s`;
}

function statRows(team: TeamView): string {
  const label = team.color === 'white' ? 'White' : 'Black';
  const seats = team.seats.filter((s: SeatView) => s.occupied);
  if (seats.length === 0) return '';
  return `<tr class="stats-team-row"><td colspan="5">${label}</td></tr>` +
    seats.map(seat => {
      const st = seat.stats;
      return `<tr>
      <td>${escapeHtml(seat.name ?? 'Player')}</td>
      <td>${st.moves + st.botMoves}</td>
      <td>${fmtAvg(st.thinkMsTotal, st.moves)}</td>
      <td class="${st.autoMoves > 0 ? 'stat-bad' : ''}">${st.autoMoves || '—'}</td>
      <td class="${st.captured > 0 ? 'stat-good' : ''}">${st.captured || '—'}</td>
    </tr>`;
    }).join('');
}

export function renderStats(el: HTMLElement, state: RoomState): void {
  const body = statRows(state.white) + statRows(state.black);
  if (!body) { el.innerHTML = `<div class="empty-note">No players seated</div>`; return; }
  el.innerHTML = `
    <table class="stats-table">
      <thead><tr>
        <th>Player</th><th title="Moves played">Mv</th>
        <th title="Average time per move">Avg</th>
        <th title="Moves forced by the clock">Auto</th>
        <th title="Material captured">Mat</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

// ---------- toasts ----------

let toastHost: HTMLElement | null = null;

export function toast(msg: string, kind: 'info' | 'danger' = 'info'): void {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    document.body.appendChild(toastHost);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind === 'danger' ? 'toast-danger' : ''}`;
  t.textContent = msg;
  toastHost.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 260);
  }, 2600);
}

// ---------- auto-move banner ----------

export function autoMoveBanner(playerName: string, san: string): void {
  const host = document.createElement('div');
  host.className = 'banner-host';
  host.innerHTML = `
    <div class="banner">
      <div>
        <div class="banner-title">Time — auto move</div>
        <div class="banner-sub">${escapeHtml(playerName)} ran out; the board played
          <b style="color:var(--text)">${escapeHtml(san)}</b></div>
      </div>
    </div>`;
  document.body.appendChild(host);
  setTimeout(() => host.remove(), 2500);
}

// ---------- modal ----------

export function modal(html: string): { host: HTMLElement; close: () => void } {
  const host = document.createElement('div');
  host.className = 'modal-host';
  host.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(host);
  return { host, close: () => host.remove() };
}

/** Promotion picker; resolves null if the player dismisses it. */
export function promotionDialog(color: 'w' | 'b'): Promise<string | null> {
  return new Promise(resolve => {
    const picks: PieceType[] = ['q', 'r', 'b', 'n'];
    const { host, close } = modal(`
      <h2>Promote</h2>
      <p>Choose the piece your pawn becomes.</p>
      <div class="promo-row">
        ${picks.map(p => `<button class="promo-btn" data-p="${p}">
          ${pieceSvg(`${color}${p}` as PieceCode)}</button>`).join('')}
      </div>`);

    host.querySelectorAll<HTMLButtonElement>('.promo-btn').forEach(b => {
      b.addEventListener('click', () => { close(); resolve(b.dataset.p!); });
    });
    host.addEventListener('click', e => {
      if (e.target === host) { close(); resolve(null); }
    });
  });
}
