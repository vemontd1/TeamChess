/**
 * Unit tests for the bug report store.
 *
 * The store is the only place in this app where a person's own words and a picture of
 * their screen are written to disk, and it is the one thing whose failure is invisible to
 * everybody: a report that does not save is a report nobody knows was made. One was lost
 * that way -- a deploy replaced the container between writing the screenshots and writing
 * the text -- so the order those two happen in, and what is left behind when one of them
 * does not, are worth pinning down.
 *
 * Runs against a temporary directory. Run through tsx, since it imports TypeScript.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-reports-'));
process.env.REPORTS_DIR = dir;

const { initReports, fileReport, listReports, setResolved, openCount } =
  await import('../server/src/reports.ts');

let failures = 0;
const log = (...a) => console.log(...a);
function check(name, cond, extra = '') {
  if (cond) log(`  PASS  ${name}`);
  else { failures++; log(`  FAIL  ${name} ${extra}`); }
}

/** A real 2x2 PNG, so the store decodes bytes rather than a string that looks like some. */
const TINY_PNG = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQ'
  + 'kAABkwAgapUdHDAAAAAElFTkSuQmCC';

const attachDir = id => path.join(dir, 'attachments', id);

log('\n=== 1. A report is text first, pictures second ===');
{
  const r = fileReport({
    text: 'The clock stopped and nobody won.',
    reporter: 'Tester',
    accountId: null,
    context: { route: '#/r/abc', viewport: '390x844' },
    attachments: [{ name: 'shot.png', dataUrl: TINY_PNG }],
  });
  check('it comes back with an id', r?.id != null);
  check('and is on disk under that id', fs.existsSync(path.join(dir, `${r.id}.json`)));

  const saved = JSON.parse(fs.readFileSync(path.join(dir, `${r.id}.json`), 'utf8'));
  check('the text is what was sent', saved.text === 'The clock stopped and nobody won.');
  check('the screenshot is recorded on it', saved.attachments.length === 1,
    JSON.stringify(saved.attachments));
  check('and the bytes are beside it',
    fs.existsSync(path.join(attachDir(r.id), `${saved.attachments[0].id}.png`)));
  check('an empty report is refused',
    fileReport({ text: '   ', reporter: 'Tester', accountId: null, context: {} }) === null);
}

log('\n=== 2. Resolving throws the pictures away ===');
{
  const r = fileReport({
    text: 'Something else went wrong.', reporter: 'Tester', accountId: null, context: {},
    attachments: [{ name: 'a.png', dataUrl: TINY_PNG }],
  });
  check('two reports are open', openCount() === 2, String(openCount()));

  const done = setResolved(r.id, true);
  check('resolving clears the list of attachments', done.attachments.length === 0);
  check('and the folder with them', !fs.existsSync(attachDir(r.id)));
  check('the report itself stays', fs.existsSync(path.join(dir, `${r.id}.json`)));
  check('and it is no longer counted as open', openCount() === 1, String(openCount()));

  const back = setResolved(r.id, false);
  check('reopening does not conjure the pictures back', back.attachments.length === 0);
}

log('\n=== 3. Screenshots with no report do not survive a restart ===');
{
  // Exactly what the lost report left behind: a folder of images with no text anywhere.
  const orphan = attachDir('2026-01-01-deadbeef');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'aaaaaaaaaaaa.png'), 'bytes');
  check('an orphan can be planted', fs.existsSync(orphan));

  // A fresh module, as though the server had restarted against the same directory.
  const fresh = await import(`../server/src/reports.ts?restart=${Date.now()}`);
  fresh.initReports();

  check('it is swept at startup', !fs.existsSync(orphan));
  check('and the reports that do exist are still there',
    fresh.listReports(10).length === 2, String(fresh.listReports(10).length));
  check('including the one whose pictures were deleted on purpose',
    fresh.listReports(10).some(r => r.text.includes('Something else')));
}

fs.rmSync(dir, { recursive: true, force: true });
log(`\n${failures === 0 ? 'ALL REPORT CHECKS PASSED' : `${failures} REPORT CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
