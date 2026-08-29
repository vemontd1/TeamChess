import type { TeamView, Color, You, RoomState } from '../types';
import { escapeHtml } from './timerRing';

export interface TeamPanelHandlers {
  onTake: (color: Color, seatId: number) => void;
  onLeave: () => void;
  onToggleBot: (color: Color, seatId: number, bot: boolean) => void;
}

/**
 * A team roster. The active seat is tracked between renders so control visibly moves
 * from one card to the next -- the handoff is the clearest signal of how this game
 * differs from ordinary chess, so it gets a real animation rather than a colour swap.
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

    this.el.classList.toggle('team-on', live);

    this.el.innerHTML = `
      <div class="panel-head team-head">
        <span class="team-dot ${this.color === 'white' ? 'w' : 'b'}"></span>
        <span class="team-name">${label}</span>
        <span class="team-meta">${filled}/${team.seats.length}</span>
      </div>
      <div class="roster">
        ${team.seats.map(seat => {
          const mine = you?.seat?.color === this.color && you.seat.seatId === seat.id;
          const isActive = live && active === seat.id;
          const cls = [
            'seat',
            isActive ? 'seat-active' : '',
            !seat.occupied ? 'seat-empty' : '',
          ].filter(Boolean).join(' ');

          const name = seat.occupied
            ? escapeHtml(seat.name ?? 'Player')
            : 'Open seat';

          const tags: string[] = [];
          if (mine) tags.push('<span class="seat-tag tag-you">You</span>');
          if (seat.kind === 'bot') tags.push('<span class="seat-tag tag-bot">Bot</span>');
          else if (seat.occupied && !seat.connected) {
            tags.push('<span class="seat-tag tag-off">Away</span>');
          }

          const actions: string[] = [];
          if (state.status !== 'playing') {
            if (mine) {
              actions.push(`<button class="btn btn-sm btn-ghost" data-act="leave">Leave</button>`);
            } else if (!seat.occupied) {
              actions.push(`<button class="btn btn-sm" data-act="take" data-seat="${seat.id}">Sit</button>`);
            }
            if (isHost) {
              actions.push(`<button class="btn btn-sm btn-ghost" data-act="bot"
                data-seat="${seat.id}" data-bot="${seat.kind === 'bot' ? '0' : '1'}"
                title="${seat.kind === 'bot' ? 'Make this a human seat' : 'Fill with a bot'}"
                >${seat.kind === 'bot' ? '✕' : '🤖'}</button>`);
            }
          }

          return `<div class="${cls}" data-seat-id="${seat.id}">
            <span class="seat-idx">${seat.id + 1}</span>
            <span class="seat-name">${name}</span>
            ${tags.join('')}
            <span class="seat-actions">${actions.join('')}</span>
          </div>`;
        }).join('')}
      </div>`;

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
        const act = btn.dataset.act;
        const seatId = Number(btn.dataset.seat);
        if (act === 'take') this.handlers.onTake(this.color, seatId);
        else if (act === 'leave') this.handlers.onLeave();
        else if (act === 'bot') {
          this.handlers.onToggleBot(this.color, seatId, btn.dataset.bot === '1');
        }
      });
    });
  }
}
