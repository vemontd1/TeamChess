import type { TeamView, Color, You, RoomState } from '../types';
import { escapeHtml } from './timerRing';

export interface TeamPanelHandlers {
  /** Join this side. The server picks the seat. */
  onJoin: (color: Color) => void;
  onLeave: () => void;
  /** Host only: add a bot to this side, or take a named one back out. */
  onAddBot: (color: Color) => void;
  onRemoveBot: (color: Color, seatId: number) => void;
}

/**
 * A team roster.
 *
 * The seats used to carry their own controls: a Sit button on every empty row and, for the
 * host, a bot toggle on every row including occupied ones. That put two contradictory
 * offers on the same slot -- sit here, and also make this a bot -- and the second one
 * evicted whoever took the first. It also asked a question nobody has an answer to: which
 * of three identical empty chairs would you like?
 *
 * So the seats are a list now, and the actions belong to the team: one Join, and for the
 * host one Add bot. Removing a bot stays on the bot's own row, because that one *is* about
 * a particular seat.
 *
 * The active seat is tracked between renders so control visibly moves from one card to the
 * next -- the handoff is the clearest signal of how this game differs from ordinary chess,
 * so it gets a real animation rather than a colour swap.
 */
export class TeamPanel {
  readonly el: HTMLElement;
  private color: Color;
  private handlers: TeamPanelHandlers;
  private prevActive: number | null = null;

  constructor(color: Color, handlers: TeamPanelHandlers) {
    this.color = color;
    this.handlers = handlers;
    this.el = document.createElement('section');
    this.el.className = 'panel edge team';
  }

  render(team: TeamView, state: RoomState, you: You | null, isHost: boolean): void {
    const live = state.status === 'playing' && state.activeColor === this.color;
    const active = team.activeSeatId;
    const label = this.color === 'white' ? 'Team White' : 'Team Black';
    const filled = team.seats.filter(s => s.occupied).length;
    const full = filled >= team.seats.length;
    const onThisTeam = you?.seat?.color === this.color;
    const seatedElsewhere = you?.seat != null && !onThisTeam;
    const lobby = state.status !== 'playing';

    this.el.classList.toggle('team-on', live);

    this.el.innerHTML = `
      <div class="panel-head team-head">
        <span class="team-dot ${this.color === 'white' ? 'w' : 'b'}"></span>
        <span class="team-name">${label}</span>
        <span class="team-meta">${filled}/${team.seats.length}</span>
      </div>
      <div class="roster">
        ${team.seats.map(seat => {
          const mine = onThisTeam && you!.seat!.seatId === seat.id;
          const isActive = live && active === seat.id;
          const cls = [
            'seat',
            isActive ? 'seat-active' : '',
            !seat.occupied ? 'seat-empty' : '',
          ].filter(Boolean).join(' ');

          const name = seat.occupied ? escapeHtml(seat.name ?? 'Player') : 'Open seat';

          const tags: string[] = [];
          if (mine) tags.push('<span class="seat-tag tag-you">You</span>');
          if (seat.kind === 'bot') tags.push('<span class="seat-tag tag-bot">Bot</span>');
          else if (seat.occupied && !seat.connected) {
            tags.push('<span class="seat-tag tag-off">Away</span>');
          }

          // The only per-seat control left, because it is the only one that is genuinely
          // about a particular seat rather than about the team.
          const actions = isHost && lobby && seat.kind === 'bot'
            ? `<button class="btn btn-sm btn-ghost seat-remove" data-act="unbot"
                 data-seat="${seat.id}" title="Remove this bot"
                 aria-label="Remove bot in seat ${seat.id + 1}">✕</button>`
            : '';

          return `<div class="${cls}" data-seat-id="${seat.id}">
            <span class="seat-idx">${seat.id + 1}</span>
            <span class="seat-name">${name}</span>
            ${tags.join('')}
            <span class="seat-actions">${actions}</span>
          </div>`;
        }).join('')}
      </div>
      ${lobby ? `<div class="team-actions">
        ${onThisTeam
          ? `<button class="btn btn-lg team-join team-leave" data-act="leave">
               Leave ${this.color === 'white' ? 'White' : 'Black'}</button>`
          : `<button class="btn btn-lg btn-primary team-join" data-act="join"
               ${full || seatedElsewhere ? 'disabled' : ''}
               title="${full ? 'This side is full'
                 : seatedElsewhere ? 'Leave your current seat first' : ''}">
               ${full ? 'Side full' : `Join ${this.color === 'white' ? 'White' : 'Black'}`}
             </button>`}
        ${isHost ? `<button class="btn btn-sm btn-ghost team-bot" data-act="bot"
             ${full ? 'disabled' : ''}
             title="${full ? 'No free seat for a bot' : 'Fill a free seat with a bot'}"
             >+ Bot</button>` : ''}
      </div>` : ''}`;

    this.wire();
    this.animateHandoff(live ? active : null);
  }

  /** Animate only when control actually moved, not on every unrelated re-render. */
  private animateHandoff(active: number | null): void {
    if (active !== this.prevActive) {
      if (this.prevActive != null) {
        const prev = this.el.querySelector<HTMLElement>(`[data-seat-id="${this.prevActive}"]`);
        prev?.classList.add('seat-yield');
      }
      if (active != null) {
        const next = this.el.querySelector<HTMLElement>(`[data-seat-id="${active}"]`);
        next?.classList.add('seat-handoff');
      }
      this.prevActive = active;
    }
  }

  private wire(): void {
    this.el.querySelectorAll<HTMLButtonElement>('[data-act]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        switch (btn.dataset.act) {
          case 'join':  this.handlers.onJoin(this.color); break;
          case 'leave': this.handlers.onLeave(); break;
          case 'bot':   this.handlers.onAddBot(this.color); break;
          case 'unbot': this.handlers.onRemoveBot(this.color, Number(btn.dataset.seat)); break;
        }
      });
    });
  }
}
