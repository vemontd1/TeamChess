import { getName, setName } from '../net/socket';
import { sfx, unlockAudio } from '../audio/sfx';
import { escapeHtml } from './timerRing';

/**
 * The name prompt for someone arriving on an invite link.
 *
 * A link lands straight in a room, skipping the home screen where the name field lives, so
 * a first-time guest used to be seated as "Player" with no chance to say who they were --
 * and in a game whose whole point is knowing which teammate is on the clock, a board of
 * Players is unusable.
 *
 * It only asks once. A returning player already has a name in localStorage and is joined
 * straight through; being re-interrogated on every refresh and every reconnect would be
 * worse than the problem.
 *
 * Doubles as the first user gesture, which is what lets the AudioContext start -- so a
 * guest hears the game from their first turn rather than from their second.
 */
export function askName(roomId: string): Promise<string> {
  return new Promise(resolve => {
    const host = document.createElement('div');
    host.className = 'modal-host';
    host.innerHTML = `
      <div class="modal name-gate">
        <div class="gate-mark">♚</div>
        <h2>Join room ${escapeHtml(roomId)}</h2>
        <p>Your teammates see this name on the roster and on the clock.</p>
        <div class="field tfield">
          <label class="label sr-only" for="gate-nm">Your name</label>
          <input id="gate-nm" maxlength="24" placeholder="Your name" autocomplete="off"
                 spellcheck="false">
        </div>
        <button class="btn btn-primary btn-lg" id="gate-go" style="width:100%">
          <span>Enter the room</span>
          <span class="btn-arrow">→</span>
        </button>
      </div>`;
    document.body.appendChild(host);

    const input = host.querySelector<HTMLInputElement>('#gate-nm')!;
    const go = host.querySelector<HTMLButtonElement>('#gate-go')!;
    input.value = getName();

    const submit = (): void => {
      const name = input.value.trim().slice(0, 24);
      if (!name) { input.focus(); host.querySelector('.name-gate')!.classList.add('shake');
        setTimeout(() => host.querySelector('.name-gate')?.classList.remove('shake'), 400);
        return; }
      unlockAudio();
      sfx.click();
      setName(name);
      host.remove();
      resolve(name);
    };

    go.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    // deliberately no dismiss-on-backdrop: there is nothing behind this but an empty room
    setTimeout(() => input.focus(), 30);
  });
}
