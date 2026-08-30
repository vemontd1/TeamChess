import { createRoom, getName, setName, resumeSession } from '../net/socket';
import { sfx, unlockAudio } from '../audio/sfx';
import { toast } from './widgets';
import { Slider, Segmented, toggle } from './controls';
import { mountProfile } from './profile';
import { AuthPanel } from './auth';
import type { Account } from '../types';

const TIMER_STOPS = [
  { value: 10, label: '10' }, { value: 15, label: '15' }, { value: 20, label: '20' },
  { value: 30, label: '30' }, { value: 45, label: '45' }, { value: 60, label: '60' },
  { value: 90, label: '90' }, { value: 120, label: '120' }, { value: 0, label: '∞' },
];

const TEAM_STOPS = [
  { value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' },
  { value: 4, label: '4' }, { value: 5, label: '5' },
];

/** Landing screen: name yourself, tune the match, then create or join. */
export function renderHome(root: HTMLElement, onGo: (roomId: string) => void): void {
  root.innerHTML = `
    <div class="home">
      <div class="home-card">
        <header class="hero">
          <div class="hero-mark">♚</div>
          <h1 class="home-title">Bolotnoye <em>Logovo</em></h1>
          <p class="home-sub">Two ways to be asked the same question — can you play the
            move you can see? Share a side with your team, or duel over a hand of cards.</p>
        </header>

        <section class="panel edge sheen">
          <div class="panel-body stack">
            <div class="field tfield">
              <label class="label" for="nm">Your name</label>
              <input id="nm" maxlength="24" placeholder="Player"
                     value="${escapeAttr(getName())}" autocomplete="off">
            </div>

            <div id="mode-slot"></div>
            <p class="mode-blurb" id="mode-blurb"></p>

            <div id="team-slot"></div>
            <div id="timer-slot"></div>

            <div class="rule"></div>

            <div class="opts">
              <div id="skip-opt">${toggle('skip', 'Skip empty seats',
                'Rotation cycles only seats that have someone in them.', true)}</div>
              ${toggle('tb', 'Allow takebacks',
                'The opposing player must accept before a move is rewound.', true)}
            </div>

            <button class="btn btn-primary btn-lg" id="create">
              <span>Create room</span>
              <span class="btn-arrow">→</span>
            </button>
          </div>
        </section>

        <div class="divider"><span>or join one</span></div>

        <section class="panel edge">
          <div class="panel-body join-row">
            <div class="field tfield code-field">
              <input id="code" maxlength="5" placeholder="code" autocomplete="off"
                     aria-label="Room code">
            </div>
            <button class="btn btn-lg" id="join">Join</button>
          </div>
        </section>

        <div id="auth-slot"></div>
        <section class="panel edge prof-panel" id="profile" hidden></section>
      </div>
    </div>`;

  const nm = root.querySelector<HTMLInputElement>('#nm')!;
  const code = root.querySelector<HTMLInputElement>('#code')!;

  const MODE_BLURB: Record<string, string> = {
    team: 'Your team shares one side. Teammates move in turn, and the clock waits '
        + 'for nobody.',
    cards: 'One against one. You may only move a piece you hold a card for — the king '
         + 'excepted, and he is always free.',
  };

  const modeSlot = root.querySelector<HTMLElement>('#mode-slot')!;
  const blurb = root.querySelector<HTMLElement>('#mode-blurb')!;
  const teamSlot = root.querySelector<HTMLElement>('#team-slot')!;
  const skipOpt = root.querySelector<HTMLElement>('#skip-opt')!;

  // Chess Cards is a duel, so the roster size and the empty-seat rule have nothing to say
  // in it; both are hidden rather than left sitting there inert.
  const paintMode = (mode: string): void => {
    blurb.textContent = MODE_BLURB[mode];
    const solo = mode === 'cards';
    teamSlot.hidden = solo;
    skipOpt.hidden = solo;
  };

  const mode = new Segmented({
    options: [
      { value: 'team', label: 'Team Chess' },
      { value: 'cards', label: 'Chess Cards' },
    ],
    value: 'team',
    onChange: v => { paintMode(v); sfx.click(); },
  });
  modeSlot.innerHTML = `<span class="label">Game mode</span>`;
  modeSlot.appendChild(mode.el);

  const teamSize = new Segmented({
    options: TEAM_STOPS.map(s => ({ value: String(s.value), label: s.label })),
    value: '3',
    onChange: () => sfx.click(),
  });
  teamSlot.innerHTML = `<span class="label">Players per team</span>`;
  teamSlot.appendChild(teamSize.el);
  paintMode('team');

  const timer = new Slider({
    stops: TIMER_STOPS,
    index: 3,                       // 30s
    title: 'Time per move',
    unit: s => (s.value === 0 ? 'no limit' : 'seconds'),
    onChange: () => sfx.pickup(),
  });
  root.querySelector('#timer-slot')!.appendChild(timer.el);

  // Your own record and the games on it. Fetched rather than waited for: neither a
  // profile nor a session that will not load may be the reason a room cannot be created.
  const showProfile = mountProfile(root.querySelector<HTMLElement>('#profile')!);

  const nameField = root.querySelector<HTMLElement>('.tfield')!;

  /**
   * Signing in takes over the name field.
   *
   * A signed-in player is named by their account -- that is the name the server will put
   * on the game record either way -- so leaving an editable name box beside it would be
   * offering a choice that does not exist.
   */
  const paintAccount = (account: Account | null): void => {
    nameField.hidden = account != null;
    if (account) nm.value = account.username;
  };

  const auth = new AuthPanel({
    onChange: account => {
      paintAccount(account);
      // A fresh account has no games yet, so this clears the panel rather than leaving
      // the previous player's list on screen.
      showProfile(account ? undefined : null);
    },
  });
  root.querySelector<HTMLElement>('#auth-slot')!.appendChild(auth.el);

  // Resume in one round trip, so a signed-in player never sees the signed-out panel flash
  // past on the way in.
  void resumeSession().then(({ account, profile }) => {
    auth.setAccount(account);
    paintAccount(account);
    showProfile(profile);
  }).catch(() => {});

  const saveName = (): string => {
    const v = nm.value.trim() || 'Player';
    setName(v);
    return v;
  };

  root.querySelector('#create')!.addEventListener('click', async () => {
    unlockAudio();
    sfx.click();
    const name = saveName();
    const secs = timer.value;
    const roomId = await createRoom(name, {
      mode: mode.value as 'team' | 'cards',
      teamSize: Number(teamSize.value),
      moveTimerSec: secs > 0 ? secs : null,
      skipEmptySeats: root.querySelector<HTMLInputElement>('#skip')!.checked,
      allowTakeback: root.querySelector<HTMLInputElement>('#tb')!.checked,
    });
    onGo(roomId);
  });

  const doJoin = (): void => {
    unlockAudio();
    const id = code.value.trim().toLowerCase();
    if (id.length < 3) {
      toast('Enter a room code', 'danger');
      code.focus();
      return;
    }
    sfx.click();
    saveName();
    onGo(id);
  };

  root.querySelector('#join')!.addEventListener('click', doJoin);
  code.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
  nm.addEventListener('keydown', e => { if (e.key === 'Enter') code.focus(); });

  // a near-silent tick on hover makes the whole panel feel responsive
  root.querySelectorAll('.btn, .seg-btn').forEach(b => {
    b.addEventListener('pointerenter', () => sfx.hover());
  });
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
