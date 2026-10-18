// The trust state `blueline pdf` and `blueline map` render a document in (6.1: these commands hand the file over
// "as a double-click does"; 6.10 When it applies, Settings › Trust; 9.9 Network policy: the strict option and the
// user-editable allowlist; 9.9 Derived files: the map probe copy is "loaded under the original's trust state").
//
// A command decides as the app decides an open (folders.ts resolveOpenTrust): `--protected`, then the trusted and
// untrusted folders, then the internet marker. Its partition policy uses the user's "Block all network in
// Protected view" and CDN allowlist. Only remembered decisions (trust.json) never apply to a command: it uses an
// in-memory TrustStore that never reads or writes trust.json, so a remembered Allow network or Enable editing is
// never turned on (the stricter direction), and a command never changes what the app remembers.
//
// The settings come from the user's config.json, read once and never written. index.ts gives a command a private
// userData before this runs, so the file is found where the app keeps it: BLUELINE_USER_DATA when set (tests;
// index.ts applied it as userData), else Electron's default userData, `<appData>/<app name>` (app.getPath
// ('appData') is not moved by setPath('userData')).

import * as path from 'node:path';
import { app } from 'electron';
import { ConfigStore } from './config';
import type { OpenDecision } from './documents';
import { resolveOpenTrust, toTrustDecision, TrustSettings, type OpenTrust } from './folders';
import type { InternetMarker, LocationOptions } from './markers';
import { appLocationOptions } from './settings-window';
import { TrustStore, type FileIdentity } from './trust-store';

/** The userData folder the app itself uses (where config.json is), whatever userData this run was given. */
export function realUserData(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BLUELINE_USER_DATA;
  if (override) return path.resolve(override);
  return path.join(app.getPath('appData'), app.name);
}

export interface CommandTrust {
  /** loadDocument's decideTrust (documents.ts LoadOptions). */
  decideTrust(realpath: string, requestedProtected: boolean): Promise<OpenDecision>;
  /** The partition policy's strict option (trust-hooks DeckPolicy.strict). */
  strict(): boolean;
  /** The partition policy's CDN allowlist (trust-hooks DeckPolicy.allowlist). */
  allowlist(): readonly string[];
  /** The last decision, for the command's log line: the trust state, the reason and the 6.10 rule. */
  describe(): string;
  /** The config.json the settings were read from. */
  readonly configFile: string;
}

export interface CommandTrustOptions {
  /** Default realUserData(). */
  userData?: string;
  /** For the refused trusted folders (home, Desktop, Downloads, temporary folders). Default appLocationOptions(). */
  location?: LocationOptions;
  platform?: NodeJS.Platform;
  readMarker?: (realpath: string) => Promise<InternetMarker>;
  readIdentity?: (realpath: string) => Promise<FileIdentity | null>;
}

/** An OpenTrust in a log line: `protected (In a folder you marked as untrusted; rule untrusted-folder)`. */
export function describeTrust(t: OpenTrust): string {
  return `${t.state} (${t.reason ? `${t.reason}; ` : ''}rule ${t.rule})`;
}

/** Reads the user's Trust settings (read-only) and decides trust for a command as the app decides an open. */
export function commandTrust(o: CommandTrustOptions = {}): CommandTrust {
  const config = ConfigStore.forUserData(o.userData ?? realUserData());
  // Read once; nothing here calls update(), so config.json is never written.
  config.load();
  const settings = new TrustSettings(config, o.location ?? appLocationOptions());
  const platform = o.platform ?? process.platform;
  const store = TrustStore.inMemory({ platform, ...(o.readIdentity ? { identityOf: o.readIdentity } : {}) });
  let last: OpenTrust | null = null;
  return {
    configFile: config.file,
    async decideTrust(realpath, requestedProtected) {
      const t = await resolveOpenTrust(realpath, requestedProtected, { store, lists: () => settings.lists(), platform, readMarker: o.readMarker, readIdentity: o.readIdentity });
      last = t;
      return {
        trust: toTrustDecision(t),
        // An empty store: nothing remembered is ever turned on (both are false here).
        allowNetwork: t.allowNetwork,
        editing: t.editing,
        received: t.receivedRemembered ? t.received : t.received ? true : null,
        markerUncertain: t.markerUncertain,
      };
    },
    strict: () => settings.strict(),
    allowlist: () => settings.allowlist(),
    describe: () => (last ? describeTrust(last) : 'not decided'),
  };
}
