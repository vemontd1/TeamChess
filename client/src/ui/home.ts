import { createRoom, getName, setName } from '../net/socket';
import { sfx, unlockAudio } from '../audio/sfx';
import { toast } from './widgets';
import { Slider, Segmented, toggle } from './controls';

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
          <p class="home-sub">Team chess with rotating control. Your team shares one side —
            each teammate moves in turn, and the clock waits for nobody.</p>
        </header>

        <section class="panel edge sheen">
          <div class="panel-body stack">
            <div class="field tfield">
              <label class="label" for="nm">Your name</label>
              <input id="nm" maxlength="24" placeholder="Player"
                     value="${escapeAttr(getName())}" autocomplete="off">
            </div>

            <div id="team-slot"></div>
            <div id="timer-slot"></div>

            <div class="rule"></div>

            <div class="opts">
              ${toggle('skip', 'Skip empty seats',
                'Rotation cycles only seats that have someone in them.', true)}
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
      </div>
    </div>`;

  const nm = root.querySelector<HTMLInputElement>('#nm')!;
  const code = root.querySelector<HTMLInputElement>('#code')!;

  const teamSize = new Segmented({
    options: TEAM_STOPS.map(s => ({ value: String(s.value), label: s.label })),
    value: '3',
    onChange: () => sfx.click(),
  });
  const teamSlot = root.querySelector('#team-slot')!;
  teamSlot.innerHTML = `<span class="label">Players per team</span>`;
  teamSlot.appendChild(teamSize.el);

  const timer = new Slider({
    stops: TIMER_STOPS,
    index: 3,                       // 30s
    title: 'Time per move',
    unit: s => (s.value === 0 ? 'no limit' : 'seconds'),
    onChange: () => sfx.pickup(),
  });
  root.querySelector('#timer-slot')!.appendChild(timer.el);

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
