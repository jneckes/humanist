// What the Chromium fuzz gate's mutation probe judges for each written edit (main.ts probeWritten; P2-16; SPEC 10
// Phase 2 exit gate "the mutation probe passes", which is the probe of SPEC 10 Phase 0 step 4: "The node passes
// only if the sentinel appears in that DOM text node, in no other node except reported renders of the same run").
// Kept pure, with no import of the app or the editor, so test/fuzz/unit/probe-written.test.ts runs it in the
// reader-only gate too.
//
// "That DOM text node" is the node the author typed in (review finding 25): an edit is judged on it, never only on
// the run's other renders, so a write that lands in another node while the author's node keeps its old text fails
// ('[render]'). The run's other renders are judged with it. A deck that sorts what it renders moves the edited text
// to another node of the same list: that node, an exact render of the run with the new text, is then the author's
// (a render in another container never is). An edit whose node the round's walk does not show is probed on its
// own, every stop of the walk shown again after a reload (review finding 26), and fails when nothing shows it then.

/** A text node as a walk counted it: its locator key (probe.ts locatorKey), its text, its exact run if any. */
export interface SeenNode {
  key: string;
  data: string;
  /** The run the matcher maps the node to exactly (match confidence 'exact'), else null. */
  exact: string | null;
}

/** A field's text node: its locator key and its text when the field opened. */
export interface FieldNode {
  key: string;
  data: string;
}

/** A written edit, as the probe's selection needs it. */
export interface WrittenEdit {
  /** The run the edit was written to (WriteOutcome.runId: the commit's run). */
  runId: string;
  /** The run's text in the file now: the edit's new text (under --negative-control, the text planted after it). */
  text: string;
  /** The request carried a pick (P2-8): the author chose the run for the clicked node in the picker. */
  pick: boolean;
  /** The node the author clicked and the run it was edited as (its exact run, or the picked candidate). */
  target: FieldNode & { runId: string };
  /** The field's text nodes that map to a run (core FieldRun, as the overlay records them). */
  field: readonly (FieldNode & { runId: string })[];
}

/**
 * The node(s) the author typed in: the picked node for a pick; the clicked node when the commit landed on its run;
 * otherwise the field's text node(s) of the run the commit names (an edit made elsewhere in the field, or with the
 * caret in another run, 9.2 Committing an edit step 2).
 */
export function authorNodes(e: WrittenEdit): FieldNode[] {
  if (e.pick || e.runId === e.target.runId) return [{ key: e.target.key, data: e.target.data }];
  const out: FieldNode[] = [];
  for (const p of e.field) if (p.runId === e.runId && !out.some((x) => x.key === p.key)) out.push({ key: p.key, data: p.data });
  return out;
}

/**
 * An author's node to find again: its locator key, and the other texts the walk before the edit saw at that
 * locator (a container a deck re-renders on every slide shows each slide's text in "the same" node): a copy that
 * reads one of those is that slide's, not the author's node.
 */
export interface AuthorNode {
  key: string;
  others: ReadonlySet<string>;
}

export type Selection<N extends SeenNode> =
  /** Probe `author` (each must read the new text plus the sentinel) together with the run's other renders. */
  | { kind: 'probe'; author: N[]; extra: N[] }
  /** A picked run: judged on its picked node and on where else the sentinel lands (probe.ts NodeCheck.pickedRun). */
  | { kind: 'picked'; node: N }
  /** The node the author typed in reads other text after the edit: a failure, whatever the run's other renders show. */
  | { kind: 'render'; node: N }
  /** The round's walk does not show the node the author typed in: probe the edit on its own (main.ts probeAlone). */
  | { kind: 'alone'; author: AuthorNode[] }
  /** The field holds no node of the run the commit names (the commit oracle would have failed it): a failure. */
  | { kind: 'lost' };

/**
 * Whether two locator keys name nodes of the same list: a deck that sorts what it renders moves a label between
 * them. A key is probe.ts locatorKey, `stamp \0 cssPath \0 childIndex`, and core dom-walk cssPath steps down from
 * the nearest id with one `tag:nth-of-type(n)` step per level. Same list: the same stamp, the same text index, and
 * CSS paths that differ in exactly one step, and there only in its :nth-of-type index (`#full > li:nth-of-type(3)`
 * and `#full > li:nth-of-type(7)`, or `#chart > g:nth-of-type(2) > text:nth-of-type(1)` and the same with `g:…(5)`).
 * Another container (`#nav > li:…`), another tag, another depth or a key of another shape is not the same list.
 */
export function sameList(a: string, b: string): boolean {
  if (a === b) return false;
  const pa = a.split('\u0000');
  const pb = b.split('\u0000');
  if (pa.length !== 3 || pb.length !== 3 || pa[0] !== pb[0] || pa[2] !== pb[2]) return false;
  const sa = pa[1].split(' > ');
  const sb = pb[1].split(' > ');
  if (sa.length !== sb.length) return false;
  let differ = 0;
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] === sb[i]) continue;
    const ma = /^(.+):nth-of-type\((\d+)\)$/.exec(sa[i]);
    const mb = /^(.+):nth-of-type\((\d+)\)$/.exec(sb[i]);
    if (!ma || !mb || ma[1] !== mb[1]) return false;
    if (++differ > 1) return false;
  }
  return differ === 1;
}

/** Whether a copy at an author's locator is the author's node (its old text, its new text, or text never seen there). */
export function isAuthorCopy(a: AuthorNode, data: string, want: string): boolean {
  return data === want || !a.others.has(data);
}

/**
 * For one written edit: the nodes of the walk of the version the round's edits produced (`after`) that the probe
 * judges, given the walk of the version before them (`before`). The author's node is found by its locator. The
 * run's other renders are its exact nodes after the edit, and the nodes where the walk before saw the run that now
 * read its new text (a node another run's text now shows is that run's business, and a render the deck transforms,
 * such as a label it cuts short, is not the node the author typed in).
 */
export function selectNodes<N extends SeenNode>(e: WrittenEdit, before: readonly N[], after: readonly N[]): Selection<N> {
  const nodes = authorNodes(e);
  if (nodes.length === 0) return { kind: 'lost' };
  const author: AuthorNode[] = nodes.map((a) => ({ key: a.key, others: new Set(before.filter((n) => n.key === a.key && n.data !== a.data).map((n) => n.data)) }));
  if (e.pick) {
    const here = after.filter((n) => n.key === author[0].key);
    const node = here.find((n) => !author[0].others.has(n.data)) ?? here[0];
    return node ? { kind: 'picked', node } : { kind: 'alone', author };
  }
  const found: N[] = [];
  let missing = false;
  for (let i = 0; i < author.length; i++) {
    const a = author[i];
    const old = nodes[i].data;
    const here = after.filter((n) => n.key === a.key && isAuthorCopy(a, n.data, e.text));
    if (here.length === 0) {
      missing = true;
      continue;
    }
    const shows = here.find((n) => n.data === e.text);
    if (shows) {
      found.push(shows);
      continue;
    }
    // A deck that orders what it renders by the text (a sorted list, a ranked chart) moves the edited label to
    // another node (finding 25 re-verification): the author's locator then reads another run's current text
    // exactly, not its own old text, and a node of the same list (sameList) shows the run's new text exactly. That
    // node is the author's, moved. A render in another container never stands in for it (the repair's
    // re-verification: a deck that also lists the labels cut short elsewhere would be judged on the other list).
    // A locator that reads text no run holds (a write that landed elsewhere, a render the deck cut short) or still
    // reads its old text fails.
    const moved = here.every((n) => n.exact !== null && n.exact !== e.runId && n.data !== old)
      ? after.find((n) => n.exact === e.runId && n.data === e.text && !found.includes(n) && sameList(a.key, n.key))
      : undefined;
    if (!moved) return { kind: 'render', node: here[0] };
    found.push(moved);
  }
  if (missing) return { kind: 'alone', author };
  const was = new Set(before.filter((n) => n.exact === e.runId).map((n) => n.key));
  const extra = after.filter((n) => !found.includes(n) && (n.exact === e.runId || (was.has(n.key) && n.data === e.text)));
  return { kind: 'probe', author: found, extra };
}

/**
 * The comparison with the walk of the version before the round's edits, for every round that wrote anything
 * (SPEC 10 Phase 0 probe step 4: no new console error, the same slide count), whether or not any node is left to
 * probe: the walk of the new version is itself a load of it. `errors` and `baseline` are normalized messages.
 * Returns why the round fails, or null.
 */
export function roundCheck(o: { baseline: ReadonlySet<string>; errors: readonly string[]; slidesBefore: number; slidesAfter: number }): string | null {
  const fresh = o.errors.find((m) => !o.baseline.has(m));
  if (fresh !== undefined) return `new console error after the round's edits: ${fresh.slice(0, 200)}`;
  if (o.slidesAfter !== o.slidesBefore) return `the slide count changed from ${o.slidesBefore} to ${o.slidesAfter} after the round's edits`;
  return null;
}

/** One stop of a single probe (main.ts probeAlone): the copy holds the edit and the sentinel, reloaded. */
export interface AloneStop {
  /** The replay showed the stop's slide again. */
  reached: boolean;
  /**
   * The text nodes at the author's locators at this stop (a locator that finds no text node is left out): `visible`
   * is the walk's test (SPEC 10 Phase 0 step 4); `laidOut` (a non-zero rect), `inView` (the rect meets the
   * viewport) and `onSlide` (the stop shows the slide that holds the node; absent when unknown) only say, for the
   * report, why a node that is not visible is not.
   */
  nodes: readonly { key: string; data: string; visible: boolean; laidOut?: boolean; inView?: boolean; onSlide?: boolean }[];
  /**
   * probe.ts judgeNode on everything but the node's own text (NodeCheck.pickedRun): the sentinel in no node other
   * than reported renders of the run, no new console error, the same slide count.
   */
  rest: { pass: boolean; why?: string };
}

export type AloneVerdict = { pass: true } | { pass: false; render: true; reads: string } | { pass: false; render: false; why: string };

/**
 * The verdict of a single probe: every stop the replay reached must pass `rest`, and each of the author's nodes
 * must be visible at some stop reading `want` (the new text plus the sentinel; null for a picked node, which need
 * only be shown). A node that is shown but reads other text is a '[render]' failure; one shown at no stop means the
 * edit shows nowhere.
 */
export function judgeAlone(stops: readonly AloneStop[], o: { author: readonly AuthorNode[]; want: string | null }): AloneVerdict {
  const reached = stops.filter((s) => s.reached);
  if (reached.length === 0) return { pass: false, render: false, why: `no stop of the walk could be shown again after the reload (${stops.length} stops)` };
  const broken = reached.find((s) => !s.rest.pass);
  if (broken) return { pass: false, render: false, why: broken.rest.why ?? 'the probe could not check it' };
  for (const a of o.author) {
    const present = reached.flatMap((s) => s.nodes.filter((n) => n.key === a.key && (o.want === null ? !a.others.has(n.data) : isAuthorCopy(a, n.data, o.want))));
    const shown = present.filter((n) => n.visible);
    if (shown.some((n) => o.want === null || n.data === o.want)) continue;
    if (shown.length > 0) return { pass: false, render: true, reads: shown[0].data };
    // Where it is, for the report (no text: Josh's decks): not there, or there but never visible, and why not.
    // At the stops that show the node's own slide when there are any: a slide the deck has not shown is hidden.
    const withText = present.filter((n) => o.want === null || n.data === o.want);
    const own = withText.filter((n) => n.onSlide !== false);
    const basis = own.length > 0 ? own : withText;
    const where =
      withText.length === 0
        ? present.length > 0
          ? 'it is in the page, not visible at any stop, and reads other text'
          : 'it is not in the page at any stop'
        : basis.some((n) => n.laidOut && n.inView)
          ? 'it is in the page with the new text and the sentinel, in the viewport, but hidden by its style (opacity or visibility) at every stop'
          : basis.some((n) => n.laidOut)
            ? 'it is in the page with the new text and the sentinel, laid out but outside the viewport at every stop that shows its slide (text that moves, or sits off screen)'
            : 'it is in the page with the new text and the sentinel, but not laid out at any stop (hidden)';
    const missed = stops.length - reached.length;
    return {
      pass: false,
      render: false,
      why: `the edit shows nowhere: no stop of the walk shows the node the author typed in after a reload (${where}${missed > 0 ? `; ${missed} of ${stops.length} stops could not be shown again` : ''})`,
    };
  }
  return { pass: true };
}
