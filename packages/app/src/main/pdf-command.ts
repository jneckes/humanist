// `blueline pdf deck.html [-o out.pdf]` (6.1; 6.9 Save as PDF "without opening a window"), the app side:
// `--bl-cmd=pdf --bl-args=<base64url JSON PdfArgs> --bl-out=<result file>`, as `map` is run. Headless: no
// window is shown; the document renders in hidden offscreen render windows under its own trust state, decided
// as the app decides an open (command-trust.ts: `--protected`, the trusted and untrusted folders, the marker;
// never a remembered decision), in its own partition with the protocol and session policy a document window
// would install (the user's strict option and CDN allowlist). A Protected document's PDF is marked as a
// derived file (9.9; pdf.ts saveAsPdf). The PDF goes to `out`, by default `<deck basename>.pdf` next to the
// deck, never over the deck itself. The result (a PdfCommandResult) is written to --bl-out; exit 0 when every
// slide has its page, 1 when some could not be shown or the run failed, 2 for usage and open errors, 128+n on
// a signal.
//
// In test builds (BLUELINE_TEST=1, not packaged) this module also exposes `globalThis.__blRenderTest`, a
// main-process harness the E2E tests drive the render products through (index, thumbnails, Find, PDF, Print).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, session } from 'electron';
import type { FindResponse, PdfArgs, PdfCommandResult, PdfResult, SlideIndex, ThumbReady } from '@blueline/core/ipc-render';
import { commandTrust, type CommandTrust } from './command-trust';
import { loadDocument, OpenError, type BlDocument } from './documents';
import { findResponse, highlightMatch } from './find';
import { DEFAULT_ALLOWLIST, pickClosedLoopbackPort } from './network-policy';
import { defaultPdfPath, refusePdfOut, saveAsPdf } from './pdf';
import { printDocument } from './print';
import { installDeckProtocol } from './protocol';
import { disposeRenderer, noteDocumentWrite, rendererFor, renderTargetFor, setRenderHost, type RenderHost, type RenderTarget } from './render-service';
import { buildSlideIndex, designViewport, visitSlides } from './slide-index';
import { renderThumbnails } from './thumbnails';
import { installDeckSessionPolicy, type DeckSessionHandle } from './trust-hooks';

function log(msg: string): void {
  console.error(`[blueline pdf] ${msg}`);
}

const SIGNAL_EXIT: Readonly<Record<string, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

function writeResultSync(outFile: string | null, r: PdfCommandResult): void {
  if (!outFile) return;
  try {
    fs.writeFileSync(outFile, JSON.stringify(r, null, 2) + '\n', { mode: 0o600 });
  } catch (e) {
    log(`could not write ${outFile}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const MODE_TEXT: Readonly<Record<PdfResult['mode'], string>> = {
  'print-css': "the deck's print CSS",
  raster: 'one page per slide',
  document: 'document pages',
};

/** The command's text line for a written PDF (what `blueline pdf` prints). */
export function resultText(r: PdfResult): string {
  let t = `blueline pdf: wrote ${r.out} (${plural(r.pages, 'page')}, ${MODE_TEXT[r.mode]})`;
  if (r.missed.length) t += `; ${plural(r.missed.length, 'slide')} could not be shown: ${r.missed.map((i) => i + 1).join(', ')}`;
  return t;
}

/**
 * The document's partition set up as a document window sets it up: session policy (9.9) and protocol (9.1).
 * `settings` gives the strict option and the allowlist (the command's: the user's Settings › Trust); without it
 * (the test harness) strict is off and the allowlist is the 9.9 default.
 */
async function servePartition(doc: BlDocument, settings?: Pick<CommandTrust, 'strict' | 'allowlist'>): Promise<DeckSessionHandle> {
  const ses = session.fromPartition(doc.partition);
  const blockPort = await pickClosedLoopbackPort();
  const policy = installDeckSessionPolicy(ses, {
    trust: () => doc.trust(),
    networkAllowed: () => doc.networkAllowed(),
    strict: settings ? () => settings.strict() : () => false,
    allowlist: settings ? () => settings.allowlist() : () => DEFAULT_ALLOWLIST,
    blockPort,
    sourcePath: () => doc.realpath,
  });
  try {
    // 9.9: the Protected proxy must be in place and verified before the document loads.
    await policy.ready;
  } catch (e) {
    policy.dispose();
    throw e;
  }
  installDeckProtocol(ses, (id) => (id === doc.docId ? doc : undefined));
  return policy;
}

function hostFor(): RenderHost {
  return { preload: path.join(__dirname, 'preload-deck.cjs'), userData: app.getPath('userData'), log, devTools: false };
}

export interface PdfCommandInput {
  pdf: PdfArgs | null;
  out: string | null;
  errors: string[];
}

/** Runs `blueline pdf` headless; writes the PdfCommandResult to `outFile` and resolves to the exit code. */
export async function runPdfCommand(p: PdfCommandInput, opts: { parent: number | null }): Promise<number> {
  const outFile = p.out;
  if (p.errors.length > 0 || !p.pdf || !outFile) {
    const message = p.errors.length > 0 ? p.errors.join('; ') : !p.pdf ? 'missing --bl-args' : 'missing --bl-out';
    writeResultSync(outFile, { command: 'pdf', exitCode: 2, text: `blueline pdf: ${message}`, json: { error: 'usage', message } });
    log(message);
    return 2;
  }
  const args = p.pdf;
  let interrupted = false;
  /** Once interrupted, only the interrupt writes the result and exits: the run itself parks here. */
  const halt = (): Promise<never> => new Promise<never>(() => undefined);
  const interrupt = (why: string, code: number): void => {
    if (interrupted) return;
    interrupted = true;
    // The PDF is written atomically: an interrupted run leaves no partial file.
    writeResultSync(outFile, { command: 'pdf', exitCode: code, text: `blueline pdf: interrupted (${why}).`, json: { error: 'interrupted', message: why } });
    log(`${why}: stopping`);
    app.exit(code);
  };
  const onSignal = (sig: NodeJS.Signals) => interrupt(sig, SIGNAL_EXIT[sig] ?? 130);
  // Installed after ready (Electron installs its own graceful-quit handlers while it starts; F24).
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, onSignal);
  // The command that started this run may die without its signal reaching this process (under xvfb-run its
  // pid is not our parent): the run stops instead of writing a PDF nobody waits for.
  const ppid = process.ppid;
  const watchdog = setInterval(() => {
    let gone = process.ppid !== ppid;
    if (!gone && opts.parent !== null) {
      try {
        process.kill(opts.parent, 0);
      } catch (e) {
        gone = (e as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }
    if (gone) interrupt('the command that started blueline pdf went away', SIGNAL_EXIT.SIGHUP);
  }, 500);
  watchdog.unref();

  const fail = (code: number, error: 'usage' | 'failed', message: string): number => {
    log(message);
    writeResultSync(outFile, { command: 'pdf', exitCode: code, text: `blueline pdf: ${message}`, json: { error, message } });
    return code;
  };

  let doc: BlDocument | null = null;
  let policy: DeckSessionHandle | null = null;
  try {
    // The document's own trust state, as the app would open it (6.10), with the user's Trust settings.
    const trust = commandTrust();
    try {
      doc = await loadDocument(args.file, { protectedRequested: args.protected === true, decideTrust: (rp, req) => trust.decideTrust(rp, req) });
    } catch (e) {
      return fail(2, 'usage', e instanceof OpenError ? e.message : `could not open ${path.basename(args.file)}`);
    }
    // The default output sits next to the deck as the user named it (a link's folder, not its target's).
    const out = args.out ?? defaultPdfPath(path.resolve(args.file));
    const refused = await refusePdfOut(out, { realpath: doc.realpath, path: doc.path });
    if (refused) return fail(2, 'usage', refused);
    log(`${doc.fileName}: ${trust.describe()}, writing ${out}`);
    try {
      policy = await servePartition(doc, trust);
    } catch (e) {
      return fail(1, 'failed', `Protected view could not block the network, so ${doc.fileName} was not rendered (${e instanceof Error ? e.message : String(e)})`);
    }
    const host = hostFor();
    setRenderHost(host);
    const t0 = Date.now();
    const r = await saveAsPdf(renderTargetFor(doc), out, { host });
    if (interrupted) return halt();
    log(`${r.mode}: ${plural(r.pages, 'page')} in ${Date.now() - t0} ms`);
    const exitCode = r.missed.length > 0 ? 1 : 0;
    writeResultSync(outFile, { command: 'pdf', exitCode, text: resultText(r), json: r });
    return exitCode;
  } catch (e) {
    if (interrupted) return halt();
    return fail(1, 'failed', `${doc?.fileName ?? path.basename(args.file)}: the PDF could not be made: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearInterval(watchdog);
    if (!interrupted) {
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.removeListener(sig, onSignal);
      if (doc) disposeRenderer(doc.docId);
      policy?.dispose();
    }
  }
}

// ------------------------------------------------------------------------------------------- test harness

interface TestDoc {
  doc: BlDocument;
  policy: DeckSessionHandle;
  target: RenderTarget;
}

/**
 * BLUELINE_TEST=1 and not packaged only: `globalThis.__blRenderTest`, read-only drivers of the render products
 * for the E2E tests (test/e2e/render-products-*.spec.ts). Each document is opened as `blueline pdf` opens it,
 * in its own partition; nothing here is reachable from any renderer.
 */
export function exposeRenderTestHooks(): void {
  const g = globalThis as Record<string, unknown>;
  if (g.__blRenderTest) return;
  const docs = new Map<string, TestDoc>();
  const get = (id: string): TestDoc => {
    const d = docs.get(id);
    if (!d) throw new Error(`no test document ${id}`);
    return d;
  };
  const host = (): RenderHost => {
    const h = hostFor();
    setRenderHost(h);
    return h;
  };
  g.__blRenderTest = {
    open: async (file: string, o: { protected?: boolean; deckNav?: { forward?: string; back?: string } } = {}) => {
      const doc = await loadDocument(file, { protectedRequested: o.protected === true });
      const policy = await servePartition(doc);
      docs.set(doc.docId, { doc, policy, target: renderTargetFor(doc, { deckNav: o.deckNav ?? null }) });
      return { docId: doc.docId, fileKey: doc.fileKey, version: doc.version, partition: doc.partition, trust: doc.trust() };
    },
    index: (id: string, o: { force?: boolean } = {}): Promise<SlideIndex> => buildSlideIndex(get(id).target, { host: host(), force: o.force === true }),
    thumbs: async (id: string, width: number) => {
      const t = get(id);
      const h = host();
      const index = await buildSlideIndex(t.target, { host: h });
      const events: ThumbReady[] = [];
      const t0 = Date.now();
      const result = await renderThumbnails(t.target, index, width, (_s, _f, info) => events.push(info), { host: h });
      return { events, result, ms: Date.now() - t0, views: rendererFor(t.target, h).views };
    },
    find: async (id: string, query: string): Promise<FindResponse> => findResponse(await buildSlideIndex(get(id).target, { host: host() }), query),
    pdf: (id: string, out: string, o: { locale?: string } = {}) => saveAsPdf(get(id).target, out, { host: host(), locale: o.locale ?? null }),
    /** Print, with printToPDF of the page that would be printed in place of the system dialog. */
    print: async (id: string, pdfOut: string, o: { locale?: string } = {}) => {
      const seen: { url: string; options: Record<string, unknown>; overlay: boolean | null }[] = [];
      const r = await printDocument(get(id).target, {
        host: host(),
        locale: o.locale ?? null,
        printWith: async (wc, options) => {
          const overlay = (await Promise.race([
            wc.executeJavaScriptInIsolatedWorld(1031, [{ code: '!!document.querySelector("blueline-overlay")' }]).catch(() => null),
            new Promise((r) => setTimeout(() => r(null), 2000)),
          ])) as boolean | null;
          // null: the page runs no script at all (the print-only document), so it has no overlay either.
          seen.push({ url: wc.getURL().replace(/^blueline:\/\/[0-9a-f]{16}/, 'blueline://ID'), options: { ...options }, overlay: typeof overlay === 'boolean' ? overlay : null });
          const bytes = await wc.printToPDF({ printBackground: options.printBackground === true, ...(options.pageSize ? { pageSize: options.pageSize as 'A4' } : {}), landscape: options.landscape === true });
          fs.writeFileSync(pdfOut, bytes);
          return { ok: true, why: '' };
        },
      });
      return { ...r, seen };
    },
    /** Shows `slide` in a render view and highlights the match there with findInPage (6.9 Find). */
    highlight: async (id: string, slide: number, text: string, occurrence: number) => {
      const t = get(id);
      const h = host();
      const index = await buildSlideIndex(t.target, { host: h });
      let out: unknown = null;
      await rendererFor(t.target, h).use(designViewport(index), (view) =>
        visitSlides(
          view,
          t.target,
          index,
          async () => {
            const pageWide = index.kind === 'scroll' || index.kind === 'single';
            const r = await highlightMatch(view.wc, { text, occurrence, pageWide }, { width: index.designSize.w, height: index.designSize.h });
            out = { ...r, scrollY: (await view.current()).scrollY };
          },
          { only: new Set([slide]) },
        ),
      );
      return out;
    },
    noteWrite: (id: string) => noteDocumentWrite(get(id).doc.fileKey),
    views: (id: string) => rendererFor(get(id).target, host()).views,
    close: (id: string) => {
      const t = docs.get(id);
      if (!t) return;
      docs.delete(id);
      disposeRenderer(id);
      t.policy.dispose();
    },
  };
}

if (process.env.BLUELINE_TEST === '1' && !app.isPackaged) exposeRenderTestHooks();
