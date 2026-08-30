import { escapeHtml } from '../util/format';
import { avatarHtml } from './avatar';
import { toast } from './widgets';
import * as net from '../net/socket';
import type { FriendView, FriendsView } from '../types';

/**
 * Friends: who you play with, whether they are here, and how to get them into your room.
 *
 * One panel, three lists, and a field to add somebody by name. The lists are separate
 * because they need different answers from the reader: a friend has an invitation to
 * send, a request waiting on you has a yes or a no, and a request you have sent has
 * nothing to do but be withdrawn.
 *
 * Everything here is pushed rather than polled. The server tells this panel when the list
 * changes -- because somebody accepted, or came online, or went to a room -- so an online
 * dot is worth believing.
 */

export interface FriendsPanelOptions {
  /**
   * What the button beside a friend does.
   *
   * In a room it invites them into it; anywhere else it offers to follow them into
   * whatever room they are in, which is the same button pointed the other way.
   */
  mode: 'invite' | 'follow';
  /** Told when the panel has redrawn, so a caller can re-measure around it. */
  onChange?: () => void;
}

const EMPTY: FriendsView = { friends: [], incoming: [], outgoing: [] };

function where(f: FriendView, mode: FriendsPanelOptions['mode']): string {
  if (!f.online) return 'offline';
  if (f.roomId) return mode === 'invite' ? `in room ${f.roomId.toUpperCase()}` : 'in a game';
  return 'online';
}

function row(f: FriendView, mode: FriendsPanelOptions['mode'], kind: string): string {
  const action = kind === 'friend'
    ? (mode === 'invite'
      ? `<button class="btn btn-sm fr-act" data-act="invite" data-id="${escapeHtml(f.id)}"
          ${f.online ? '' : 'disabled'}>Invite</button>`
      : (f.roomId
        ? `<a class="btn btn-sm fr-act" href="#/r/${escapeHtml(f.roomId)}">Join</a>`
        : ''))
    : kind === 'incoming'
      ? `<button class="btn btn-sm btn-primary fr-act" data-act="accept"
           data-id="${escapeHtml(f.id)}">Accept</button>`
      : '<span class="fr-wait">asked</span>';

  return `<li class="fr-row${f.online ? ' fr-on' : ''}">
    ${avatarHtml(f.name, 'sm')}
    <span class="fr-name">${escapeHtml(f.name)}</span>
    <span class="fr-where">${escapeHtml(where(f, mode))}</span>
    ${action}
    <button class="btn btn-sm btn-ghost fr-drop" data-act="remove"
      data-id="${escapeHtml(f.id)}"
      title="${kind === 'friend' ? 'Remove this friend'
        : kind === 'incoming' ? 'Decline' : 'Withdraw'}">×</button>
  </li>`;
}

export class FriendsPanel {
  readonly el: HTMLElement;
  private opts: FriendsPanelOptions;
  private view: FriendsView = EMPTY;
  private live = true;

  constructor(opts: FriendsPanelOptions) {
    this.opts = opts;
    this.el = document.createElement('section');
    this.el.className = 'panel edge friends';
    this.paint();

    net.onFriends(view => { if (this.live) this.set(view); });
    void net.friendsList().then(v => { if (v && this.live) this.set(v); });
  }

  set(view: FriendsView): void {
    this.view = view;
    this.paint();
    this.opts.onChange?.();
  }

  destroy(): void { this.live = false; }

  private paint(): void {
    const { friends, incoming, outgoing } = this.view;
    const onlineCount = friends.filter(f => f.online).length;

    this.el.innerHTML = `
      <div class="panel-head">
        <span class="panel-title">Friends</span>
        ${friends.length > 0
          ? `<span class="games-count">${onlineCount} of ${friends.length} online</span>`
          : ''}
      </div>

      <form class="fr-add" id="fr-add" autocomplete="off">
        <input class="input" id="fr-name" maxlength="24" placeholder="Add by username"
               aria-label="Add a friend by username">
        <button class="btn btn-sm" type="submit">Add</button>
      </form>

      ${incoming.length > 0 ? `<div class="fr-group">
        <h4>Asking to be friends</h4>
        <ul class="fr-list">${incoming.map(f => row(f, this.opts.mode, 'incoming')).join('')}</ul>
      </div>` : ''}

      <div class="fr-group">
        ${friends.length === 0
          ? `<p class="fr-empty">Nobody yet. Add a player by the name they signed up with
             — once you are both friends you can see when they are online and pull them
             into a room.</p>`
          : `<ul class="fr-list">${friends.map(f => row(f, this.opts.mode, 'friend')).join('')}</ul>`}
      </div>

      ${outgoing.length > 0 ? `<div class="fr-group">
        <h4>Waiting on them</h4>
        <ul class="fr-list">${outgoing.map(f => row(f, this.opts.mode, 'outgoing')).join('')}</ul>
      </div>` : ''}`;

    this.wire();
  }

  private wire(): void {
    const form = this.el.querySelector<HTMLFormElement>('#fr-add')!;
    const input = this.el.querySelector<HTMLInputElement>('#fr-name')!;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      const res = await net.addFriend(name);
      if (!res.ok) { toast(res.error ?? 'Could not add them', 'danger'); return; }
      input.value = '';
      toast(res.accepted ? `You and ${name} are friends` : `Asked ${name}`);
    });

    this.el.querySelectorAll<HTMLElement>('[data-act]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id!;
        const act = btn.dataset.act!;
        const res = act === 'accept' ? await net.acceptFriend(id)
          : act === 'remove' ? await net.removeFriend(id)
          : await net.inviteFriend(id);
        if (!res.ok) { toast(res.error ?? 'That did not work', 'danger'); return; }
        if (act === 'invite') toast('Invitation sent');
      });
    });
  }
}

/**
 * A friend is asking you to join them.
 *
 * A toast rather than a dialog: an invitation is not urgent enough to interrupt a move,
 * and one that steals the keyboard mid-game would be worse than no invitation at all.
 */
export function showInvite(fromName: string, roomId: string, mode: string): void {
  const host = document.createElement('div');
  host.className = 'invite-card';
  host.innerHTML = `
    <div class="invite-who">${avatarHtml(fromName, 'sm')}
      <span><b>${escapeHtml(fromName)}</b> invites you to
        ${mode === 'cards' ? 'Chess Cards' : 'Team Chess'}</span></div>
    <div class="invite-actions">
      <a class="btn btn-sm btn-primary" href="#/r/${escapeHtml(roomId)}">Join</a>
      <button class="btn btn-sm btn-ghost" data-act="no">Not now</button>
    </div>`;
  document.body.appendChild(host);

  const close = (): void => host.remove();
  host.querySelector('[data-act="no"]')!.addEventListener('click', close);
  host.querySelector('a')!.addEventListener('click', close);
  // Long enough to read and decide, short enough not to sit there through a game.
  setTimeout(close, 30_000);
}
