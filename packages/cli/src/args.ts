// `blueline` command line (6.1 The command line tool). Pure: argv in, a command out.
//
//   blueline deck.html                    = blueline open deck.html
//   blueline open deck.html [--protected]
//   blueline map deck.html [--report] [--json] [--min-coverage 0.95]
//   blueline check [--auto] [--json]
//   blueline pdf | mcp | export | attach  later phases

export type CliCommand =
  | { kind: 'open'; files: string[]; protected: boolean }
  | { kind: 'map'; deck: string; report: boolean; json: boolean; minCoverage: number | null }
  | { kind: 'check'; auto: boolean; json: boolean }
  | { kind: 'later'; name: string; phase: number }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'usage'; message: string };

/** Commands of later phases (6.1, section 10): pdf with the reader, export with Review, mcp with the agent loop, attach with voices. */
export const LATER: Readonly<Record<string, number>> = Object.freeze({ pdf: 1, export: 3, mcp: 4, attach: 5 });

export const USAGE = `Usage:
  blueline <file.html>…                 open files in Blueline (same as: blueline open)
  blueline open <file.html>… [--protected]
  blueline map <deck.html> [--report] [--json] [--min-coverage 0.95]
  blueline check [--auto] [--json]      open the Diagnostics window
  blueline pdf | export | mcp | attach  arrive in later phases

Options:
  --protected          open in Protected view (network and editing off)
  --report             map: list every string that is not exact, with its slide and reason
  --json               print the result as JSON
  --min-coverage N     map: exit 1 when coverage is below N (0 to 1)
  --auto               check: run only the automatic checks
  -h, --help           show this help
  -v, --version        show the version`;

function usage(message: string): CliCommand {
  return { kind: 'usage', message };
}

/** Parses `blueline` arguments (process.argv without node and the script). */
export function parseCli(argv: readonly string[]): CliCommand {
  if (argv.length === 0) return usage('Give a file to open, or a command.');
  const [first, ...rest] = argv;
  if (first === '-h' || first === '--help' || first === 'help') return { kind: 'help' };
  if (first === '-v' || first === '--version' || first === 'version') return { kind: 'version' };
  if (Object.prototype.hasOwnProperty.call(LATER, first)) return { kind: 'later', name: first, phase: LATER[first] };
  if (first === 'open') return parseOpen(rest);
  if (first === 'map') return parseMap(rest);
  if (first === 'check') return parseCheck(rest);
  // The bare form: `blueline deck.html` is `blueline open deck.html`.
  return parseOpen(argv);
}

function parseOpen(args: readonly string[]): CliCommand {
  const files: string[] = [];
  let prot = false;
  let rawFiles = false;
  for (const a of args) {
    if (rawFiles) files.push(a);
    else if (a === '--') rawFiles = true;
    else if (a === '--protected') prot = true;
    else if (a.startsWith('-')) return usage(`Unknown option ${a} for open.`);
    else files.push(a);
  }
  if (files.length === 0) return usage('Give a file to open.');
  if (files.some((f) => f.length === 0 || f.includes('\0'))) return usage('Not a file path.');
  return { kind: 'open', files, protected: prot };
}

/** A coverage threshold: a number from 0 to 1 (section 10: `--min-coverage 0.95`). */
export function parseCoverage(s: string | undefined): number | null {
  if (s === undefined || !/^(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/.test(s.trim())) return null;
  const n = Number(s.trim());
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

function parseMap(args: readonly string[]): CliCommand {
  let deck: string | null = null;
  let report = false;
  let json = false;
  let minCoverage: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--report') report = true;
    else if (a === '--json') json = true;
    else if (a === '--min-coverage' || a.startsWith('--min-coverage=')) {
      const v = a === '--min-coverage' ? args[++i] : a.slice('--min-coverage='.length);
      const n = parseCoverage(v);
      if (n === null) return usage('--min-coverage takes a number from 0 to 1, for example 0.95.');
      minCoverage = n;
    } else if (a.startsWith('-')) return usage(`Unknown option ${a} for map.`);
    else if (deck === null) deck = a;
    else return usage('map takes one deck.');
  }
  if (deck === null || deck.length === 0 || deck.includes('\0')) return usage('Give the deck to map: blueline map deck.html --report');
  return { kind: 'map', deck, report, json, minCoverage };
}

function parseCheck(args: readonly string[]): CliCommand {
  let auto = false;
  let json = false;
  for (const a of args) {
    if (a === '--auto') auto = true;
    else if (a === '--json') json = true;
    else return usage(`Unknown argument ${a} for check.`);
  }
  return { kind: 'check', auto, json };
}

/** base64url JSON, as the app's --bl-args expects (packages/app/src/main/args.ts decodeArgs). */
export function encodeAppArgs(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
