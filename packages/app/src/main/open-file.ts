// Files macOS delivers through `open-file` (6.1 Mechanics: listened for early; a double-click, Open With,
// or a file dropped on the Dock icon). Pure apart from the injected spawn, so unit tests drive it.
//
// - `open` (a regular instance): the path is queued until the controller is ready, then opened, as today.
// - `map` and `check` run standalone and never open documents (6.1). LaunchServices may still route a
//   double-click to such a process (it runs the bundle's executable, so it is registered under the app's
//   bundle id), and the event must still be handled: without preventDefault macOS shows "could not be
//   opened". So the path is handed to a regular instance: a new process of the same executable, detached,
//   which takes the single-instance lock, or hands the file to the running regular instance through
//   second-instance, as a double-click does.

import type { AppCommand, OpenArgs } from '@blueline/core/ipc';
import { encodeArgs } from './args';

export interface PendingOpen {
  path: string;
  protected: boolean;
}

/** What spawning a detached process needs (node:child_process spawn, narrowed). */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore'; env: NodeJS.ProcessEnv },
) => { unref(): void; on(event: 'error', listener: (e: Error) => void): unknown };

export interface HandOffDeps {
  spawn: SpawnLike;
  /** process.execPath: the app's own executable. */
  execPath: string;
  /** process.defaultApp: a dev run (`electron <appPath> …`) needs the app folder first. */
  defaultApp: boolean;
  /** app.getAppPath(). */
  appPath: string;
  /** This process runs with --no-sandbox (development as root): the new one must too, or it cannot start. */
  noSandbox: boolean;
  env: NodeJS.ProcessEnv;
  log: (msg: string) => void;
}

/** The command line of a regular instance that opens `file` (absolute, from open-file). */
export function handOffCommand(file: string, deps: Pick<HandOffDeps, 'execPath' | 'defaultApp' | 'appPath' | 'noSandbox'>): { command: string; args: string[] } {
  const open: OpenArgs = { files: [file], protected: false };
  const args: string[] = [];
  if (deps.noSandbox) args.push('--no-sandbox');
  if (deps.defaultApp) args.push(deps.appPath);
  // Through --bl-args, not as a plain argument: a path is never read as a switch.
  args.push('--bl-cmd=open', `--bl-args=${encodeArgs(open)}`);
  return { command: deps.execPath, args };
}

/** Starts a regular instance with `file`, detached; it outlives this process. */
export function handOffToRegularInstance(file: string, deps: HandOffDeps): void {
  const { command, args } = handOffCommand(file, deps);
  try {
    const child = deps.spawn(command, args, { detached: true, stdio: 'ignore', env: deps.env });
    child.on('error', (e) => deps.log(`could not hand ${file} to Blueline: ${e.message}`));
    child.unref();
    deps.log(`handed ${file} to a regular Blueline instance`);
  } catch (e) {
    deps.log(`could not hand ${file} to Blueline: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Routes open-file events by the command this process runs. */
export class OpenFileRouter {
  private readonly early: PendingOpen[] = [];
  private deliver: ((o: PendingOpen) => void) | null = null;

  constructor(
    private readonly command: () => AppCommand,
    private readonly handOff: (file: string) => void,
  ) {}

  /** The `open-file` listener. */
  onOpenFile(event: { preventDefault(): void }, file: string): void {
    event.preventDefault();
    if (this.command() !== 'open') {
      this.handOff(file);
      return;
    }
    this.queue({ path: file, protected: false });
  }

  /** A file to open (open-file, argv, second-instance): delivered now, or once `start` has run. */
  queue(o: PendingOpen): void {
    if (this.deliver) this.deliver(o);
    else this.early.push(o);
  }

  /** The controller is ready: later files go to `deliver`; returns the files queued until now. */
  start(deliver: (o: PendingOpen) => void): PendingOpen[] {
    this.deliver = deliver;
    return this.early.splice(0);
  }
}
