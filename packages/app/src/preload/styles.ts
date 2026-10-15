// The overlay's only styles: one constructable stylesheet adopted into the closed shadow root (9.1 Preload,
// 9.6 Overlay). No url(), no @import, no fonts by URL: under `default-src 'none'` nothing may load.

export const OVERLAY_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  position: fixed; inset: 0; pointer-events: none;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #0f172a;
  --bl-ink: #2563eb; --bl-hl: #facc15; --bl-chip: #e0e7ff;
}
.root.chrome-hidden .chrome { display: none !important; }
.ink { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.ink.hidden { display: none; }
.ink .mark { opacity: 1; }
.ink .mark.done { opacity: .35; }
.ink .mark .stroke { fill: none; stroke: var(--bl-ink); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
.ink .mark .fill { fill: var(--bl-ink); stroke: none; }
.ink .mark.highlighter .fill { fill: var(--bl-hl); opacity: .45; }
.ink .mark .hit { fill: none; stroke: transparent; stroke-width: 14; pointer-events: none; }
.ink.clickable .mark .hit { pointer-events: stroke; cursor: pointer; }
.ink.clickable .mark .num { pointer-events: auto; cursor: pointer; }
.ink .mark .num { font: 600 15px/1 system-ui, sans-serif; fill: #fff; paint-order: stroke; stroke: var(--bl-ink); stroke-width: 4px; stroke-linejoin: round; }
.ink .mark.hl .stroke { stroke-width: 6; }
.ink .mark.hl .fill { filter: drop-shadow(0 0 3px var(--bl-ink)); }
.ink .pin-dot { fill: var(--bl-ink); stroke: #fff; stroke-width: 2; }
.ink .live { fill: var(--bl-ink); }
.ink .live.highlighter { fill: var(--bl-hl); opacity: .45; }
.ink .live-stroke { fill: none; stroke: var(--bl-ink); stroke-width: 3; stroke-dasharray: 6 4; }
.capture { position: fixed; inset: 0; pointer-events: none; cursor: crosshair; touch-action: none; }
.capture.active { pointer-events: auto; }
.card {
  position: fixed; width: 320px; max-width: calc(100vw - 16px); pointer-events: auto;
  background: #fff; border: 1px solid #c7d2fe; border-radius: 10px;
  box-shadow: 0 8px 28px rgba(15, 23, 42, .22); padding: 10px 12px 8px; display: flex; flex-direction: column; gap: 6px;
}
.card[hidden] { display: none; }
.card .head { display: flex; align-items: center; gap: 8px; }
.card .target { flex: 1; min-width: 0; font-size: 12px; color: #475569; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card .author { flex: none; font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--bl-chip); color: #3730a3; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card textarea {
  width: 100%; min-height: 54px; max-height: 50vh; resize: none; border: 1px solid #cbd5e1; border-radius: 6px;
  padding: 6px 8px; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #0f172a; background: #fff; overflow-y: auto;
}
.card textarea:focus { outline: 2px solid #93c5fd; outline-offset: 0; border-color: #60a5fa; }
.card .marks { display: flex; flex-wrap: wrap; gap: 4px; }
.card .marks:empty { display: none; }
.card .mark-item { font-size: 12px; padding: 1px 6px; border-radius: 6px; background: #eff6ff; color: #1d4ed8; cursor: default; }
.card .mark-item:hover { background: #dbeafe; }
.card .foot { display: flex; justify-content: space-between; font-size: 11px; color: #64748b; }
.hud {
  position: fixed; left: 12px; bottom: 12px; pointer-events: none; font-size: 12px; padding: 4px 10px; border-radius: 999px;
  background: rgba(15, 23, 42, .78); color: #fff;
}
.hud[hidden] { display: none; }
.toast {
  position: fixed; left: 50%; bottom: 48px; transform: translateX(-50%); pointer-events: none; font-size: 13px;
  padding: 8px 14px; border-radius: 8px; background: rgba(15, 23, 42, .88); color: #fff; max-width: 80vw;
}
.toast[hidden] { display: none; }
.help {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); pointer-events: auto; width: 360px; max-width: calc(100vw - 32px);
  background: #fff; border-radius: 12px; box-shadow: 0 12px 40px rgba(15, 23, 42, .3); padding: 16px 18px;
}
.help[hidden] { display: none; }
.badge {
  position: fixed; left: 50%; top: 10px; transform: translateX(-50%); pointer-events: none; font-size: 12px;
  padding: 3px 10px; border-radius: 999px; background: #fef3c7; color: #92400e; border: 1px solid #fcd34d;
}
.badge[hidden] { display: none; }
.help h2 { margin: 0 0 10px; font-size: 15px; }
.help dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin: 0; }
.help dt { font-weight: 600; font-family: ui-monospace, monospace; }
.help dd { margin: 0; color: #334155; }
`;

/** Pauses CSS animations while settling a render or editing (6.3, 6.7). Adopted into the page's document. */
export const PAUSE_ANIMATIONS_CSS = '*, *::before, *::after { animation-play-state: paused !important; }';
