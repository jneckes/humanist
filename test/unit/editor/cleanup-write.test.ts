// A commit that changes a run in two places, through the overlay's commit path (core commitField) and the real
// write queue (SPEC 9.2 Committing an edit step 3 and Write protocol; 6.3; review finding 23, lead decision E-12):
// the file keeps the deck's own &nbsp; and straight quotes between the two changes, and only what the author put
// there is cleaned.

import { describe, expect, it } from 'vitest';
import { createWriteQueue } from '@blueline/editor';
import { commitField } from '@blueline/core/edit-commit';
import { MemIO, mapOf } from './helpers';

const NB = '\u00A0';

/** Commits `after` in the field of the deck's only <h1> or <p> run (the caret in it) and writes it; returns the file. */
async function commitAndWrite(src: string, after: string): Promise<string> {
  const io = new MemIO(src);
  const map = mapOf(src);
  const run = map.runs[0];
  const res = commitField({ before: run.value, after, runs: [{ runId: run.id, start: 0, end: run.value.length, value: run.value }], caretRunId: run.id }, { smartPunctuation: true });
  if (res.kind !== 'edit') throw new Error(`not an edit: ${JSON.stringify(res)}`);
  const out = await createWriteQueue(io).edit({ version: map.version, runId: res.runId, beforeText: res.beforeText, afterText: res.afterText });
  if (!out.ok) throw new Error(`refused: ${out.why}`);
  return io.text;
}

const doc = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

describe('commitField and the write queue: two changes in one commit', () => {
  it("keeps the deck's &nbsp; between them when the commit also adds an NBSP", async () => {
    // "Delivery" -> "Deliveries", and " soon" plus an NBSP at the end (a paste or Option+Space).
    expect(await commitAndWrite(doc('<h1>Delivery in 10&nbsp;km</h1>'), `Deliveries in 10${NB}km soon${NB}`)).toBe(doc('<h1>Deliveries in 10&nbsp;km soon </h1>'));
    expect(await commitAndWrite(doc('<h1>Delivery in 10&nbsp;km</h1>'), `Deliveries in 10${NB}km, ready in 5${NB}min`)).toBe(doc('<h1>Deliveries in 10&nbsp;km, ready in 5 min</h1>'));
  });

  it('writes a pasted NBSP as a space when the commit replaced the deck\'s own', async () => {
    expect(await commitAndWrite(doc('<p>Price 10&nbsp;km away</p>'), `Price 10 km away${NB}now`)).toBe(doc('<p>Price 10 km away now</p>'));
  });

  it("keeps the deck's straight quotes between them and curls only the typed ones", async () => {
    expect(await commitAndWrite(doc('<p>\u201CA\u201D and "b" end</p>'), '\u201CAA\u201D and "b" end "c"')).toBe(doc('<p>\u201CAA\u201D and "b" end \u201Cc\u201D</p>'));
  });
});
