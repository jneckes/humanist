// The bundled sample deck (6.0 First run) says where the user's notes go as SPEC says they go: Blueline keeps
// them in app data (D13; 6.x Save: "Your notes are kept in Blueline."; 9.7 Persistence layout: session.json
// under <userData>/files/<fileKey>/), never next to the document and never in it until the user saves them into
// the file or sends them on (review finding 27).
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SAMPLE = path.resolve(__dirname, '../../../packages/app/assets/sample/blueline-tour.html');

/** The text a reader sees: scripts, styles and tags removed, the few entities the deck uses decoded. */
function visibleText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&rsquo;|&#8217;/g, '’')
    .replace(/\s+/g, ' ');
}

describe('the sample deck’s tour', () => {
  const text = visibleText(fs.readFileSync(SAMPLE, 'utf8'));

  it('never says notes are kept next to the file', () => {
    expect(text).not.toMatch(/next to (?:this|the|your) (?:file|deck|document)/i);
    expect(text).not.toMatch(/notes[^.]*\bbeside\b/i);
  });

  it('says Blueline keeps them, not this file', () => {
    expect(text).toMatch(/Your notes are kept in Blueline, not in this file/);
  });
});
