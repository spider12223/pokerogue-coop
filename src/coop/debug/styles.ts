/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The look of the host's debug window (DECISIONS D42): one stylesheet for both places it shows, its own browser window and
 * the panel over the game when the browser blocks the window. Every class starts with `cdw-`.
 * @module
 */

/** @param fontUrl - Where the game's pixel font is (absolute: the window has no page of its own) */
export function debugStyles(fontUrl: string): string {
  return `
@font-face { font-family: "emerald"; src: url("${fontUrl}") format("truetype"); }
.cdw-root {
  --cdw-page: #1d1826; --cdw-win: #2c2438; --cdw-panel: #3a3048; --cdw-panel-2: #44395a; --cdw-side: #261f30;
  --cdw-edge: #dd5748; --cdw-line: rgba(255, 255, 255, 0.12); --cdw-text: #f8f8f8; --cdw-muted: #c8c0d0;
  --cdw-dim: #9a90a8; --cdw-gold: #f8d030; --cdw-green: #58d070; --cdw-blue: #68a8f8; --cdw-red: #f05848;
  --cdw-input: #1f1928;
  box-sizing: border-box;
  display: flex; flex-direction: column;
  color: var(--cdw-text); background: var(--cdw-win);
  font: 18px/1.25 "emerald", sans-serif; text-shadow: 1px 1px 0 #4a4458;
}
.cdw-root *, .cdw-root *::before, .cdw-root *::after { box-sizing: border-box; }
.cdw-root button, .cdw-root input, .cdw-root select { font: inherit; color: inherit; text-shadow: inherit; }
.cdw-root[hidden] { display: none; }
.cdw-window { position: fixed; inset: 0; }
.cdw-overlay {
  position: fixed; z-index: 30; inset: 3vh 3vw;
  border: 2px solid var(--cdw-edge); border-radius: 8px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6); overflow: hidden;
}
.cdw-top {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px; padding: 8px 16px;
  background: var(--cdw-panel); border-bottom: 2px solid var(--cdw-edge);
}
.cdw-brand { color: var(--cdw-gold); font-size: 22px; }
.cdw-conn { display: flex; align-items: center; gap: 6px; color: var(--cdw-green); }
.cdw-conn::before { content: ""; width: 10px; height: 10px; border-radius: 50%; background: currentColor; box-shadow: 0 0 6px currentColor; }
.cdw-conn.cdw-off { color: var(--cdw-red); }
.cdw-stat { color: var(--cdw-muted); }
.cdw-stat b { color: var(--cdw-text); font-weight: normal; }
.cdw-spacer { flex: 1; }
.cdw-pill { padding: 2px 12px; border-radius: 99px; border: 1px solid var(--cdw-line); color: var(--cdw-dim); }
.cdw-pill.cdw-on { background: rgba(248, 208, 48, 0.18); border-color: var(--cdw-gold); color: var(--cdw-gold); }
.cdw-close { padding: 0 10px; background: transparent; border: 1px solid var(--cdw-line); border-radius: 6px; cursor: pointer; }
.cdw-close:hover { border-color: var(--cdw-edge); }
.cdw-blocked { padding: 5px 16px 4px; background: rgba(104, 168, 248, 0.14); color: var(--cdw-muted); font-size: 15px; }
.cdw-cols { flex: 1; min-height: 0; display: grid; grid-template-columns: 260px minmax(0, 1fr) 280px; }
.cdw-col { min-height: 0; overflow-y: auto; padding: 12px; }
.cdw-live, .cdw-log { background: var(--cdw-side); }
.cdw-live { border-right: 1px solid var(--cdw-line); }
.cdw-log { border-left: 1px solid var(--cdw-line); display: flex; flex-direction: column; }
.cdw-h { display: flex; justify-content: space-between; margin: 4px 0 8px; color: var(--cdw-gold); font-size: 17px; }
.cdw-h small { color: var(--cdw-dim); font-size: 15px; }
.cdw-group { margin-bottom: 14px; }
.cdw-mon {
  display: grid; grid-template-columns: 40px 1fr; gap: 0 8px; align-items: center; width: 100%;
  padding: 5px 8px; margin-bottom: 5px; text-align: left; cursor: pointer;
  background: var(--cdw-panel); border: 1px solid var(--cdw-line); border-radius: 6px;
}
.cdw-mon:hover { border-color: rgba(221, 87, 72, 0.6); }
.cdw-mon.cdw-sel { border-color: var(--cdw-gold); background: #4a3e5c; }
.cdw-mon.cdw-fainted { opacity: 0.55; }
.cdw-icon { width: 40px; height: 30px; object-fit: contain; image-rendering: pixelated; grid-row: span 2; }
.cdw-icon-big { width: 64px; height: 48px; object-fit: contain; image-rendering: pixelated; }
.cdw-name { display: flex; gap: 6px; align-items: baseline; font-size: 17px; min-width: 0; }
.cdw-name > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cdw-lv { color: var(--cdw-muted); font-size: 15px; white-space: nowrap; }
.cdw-tag { margin-left: auto; font-size: 14px; color: var(--cdw-dim); white-space: nowrap; }
.cdw-tag.cdw-me { color: var(--cdw-blue); }
.cdw-tag.cdw-field::before { content: "◆ "; color: var(--cdw-gold); }
.cdw-hp { display: flex; align-items: center; gap: 6px; font-size: 14px; color: var(--cdw-muted); }
.cdw-bar { flex: 1; height: 6px; background: #1a1522; border-radius: 3px; overflow: hidden; }
.cdw-bar i { display: block; height: 100%; background: var(--cdw-green); }
.cdw-bar i.cdw-mid { background: var(--cdw-gold); }
.cdw-bar i.cdw-low { background: var(--cdw-red); }
.cdw-status { padding: 0 5px; border-radius: 3px; font-size: 13px; text-shadow: none; color: #1d1826; background: var(--cdw-gold); }
.cdw-boss { display: flex; gap: 2px; }
.cdw-boss i { width: 12px; height: 6px; border-radius: 2px; background: var(--cdw-red); }
.cdw-boss i.cdw-gone { background: #1a1522; }
.cdw-note { padding: 6px 8px; border: 1px dashed var(--cdw-line); border-radius: 6px; color: var(--cdw-muted); font-size: 15px; }
.cdw-main { padding: 12px 16px; }
.cdw-search {
  width: 100%; padding: 6px 12px; margin-bottom: 10px; outline: none;
  background: var(--cdw-input); border: 1px solid var(--cdw-line); border-radius: 6px;
}
.cdw-search:focus, .cdw-in:focus { border-color: var(--cdw-edge); }
.cdw-quick { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.cdw-btn {
  padding: 3px 12px 2px; border-radius: 6px; cursor: pointer;
  background: var(--cdw-panel-2); border: 1px solid rgba(255, 255, 255, 0.22);
}
.cdw-btn:hover { border-color: var(--cdw-edge); }
.cdw-btn.cdw-hot { background: rgba(221, 87, 72, 0.35); border-color: var(--cdw-edge); }
.cdw-btn.cdw-small { padding: 1px 8px 0; font-size: 16px; }
.cdw-btn.cdw-danger { border-color: #a03838; color: #ffb0a8; background: transparent; }
.cdw-btn.cdw-danger.cdw-armed { background: rgba(240, 88, 72, 0.3); color: #fff; }
.cdw-sw {
  display: inline-flex; align-items: center; gap: 8px; padding: 3px 10px 2px; cursor: pointer;
  border-radius: 6px; background: var(--cdw-panel-2); border: 1px solid rgba(255, 255, 255, 0.22);
}
.cdw-sw i { width: 30px; height: 16px; border-radius: 99px; background: #1a1522; position: relative; flex: none; }
.cdw-sw i::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
  background: var(--cdw-dim); transition: left 0.15s, background 0.15s;
}
.cdw-sw.cdw-on i { background: rgba(88, 208, 112, 0.35); }
.cdw-sw.cdw-on i::after { left: 16px; background: var(--cdw-green); }
.cdw-tabs { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 2px solid var(--cdw-edge); margin-bottom: 12px; }
.cdw-tabs button {
  padding: 5px 14px 3px; cursor: pointer; color: var(--cdw-muted); background: transparent;
  border: 1px solid var(--cdw-line); border-bottom: none; border-radius: 6px 6px 0 0;
}
.cdw-tabs button.cdw-on { background: var(--cdw-edge); color: #fff; border-color: var(--cdw-edge); }
.cdw-who {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-bottom: 12px; padding: 10px 12px;
  background: var(--cdw-panel); border: 1px solid var(--cdw-line); border-radius: 8px;
}
.cdw-big { font-size: 24px; }
.cdw-meta { color: var(--cdw-muted); font-size: 16px; }
.cdw-acts { margin-left: auto; display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.cdw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 10px 14px; }
.cdw-wide { grid-column: 1 / -1; }
.cdw-f { padding: 7px 10px 6px; background: var(--cdw-panel); border: 1px solid var(--cdw-line); border-radius: 8px; min-width: 0; }
.cdw-f > label { display: flex; gap: 8px; align-items: baseline; color: var(--cdw-gold); font-size: 16px; margin-bottom: 4px; }
.cdw-f > label .cdw-wait { color: var(--cdw-gold); font-size: 13px; padding: 0 6px; border: 1px solid var(--cdw-gold); border-radius: 99px; }
.cdw-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.cdw-hint { margin-top: 4px; color: var(--cdw-dim); font-size: 14px; }
.cdw-num { display: inline-flex; align-items: stretch; border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 6px; overflow: hidden; }
.cdw-num button { width: 28px; background: var(--cdw-panel-2); border: none; cursor: pointer; }
.cdw-num button:hover { background: var(--cdw-edge); }
.cdw-num input { width: 72px; text-align: center; background: var(--cdw-input); border: none; outline: none; padding: 2px 0 1px; }
.cdw-in {
  min-width: 0; padding: 2px 8px 1px; outline: none;
  background: var(--cdw-input); border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 6px;
}
select.cdw-in option { color: #000; text-shadow: none; }
.cdw-seg { display: inline-flex; flex-wrap: wrap; border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 6px; overflow: hidden; }
.cdw-seg button { padding: 1px 11px 0; background: transparent; border: none; border-right: 1px solid var(--cdw-line); cursor: pointer; }
.cdw-seg button:last-child { border-right: none; }
.cdw-seg button:hover { background: rgba(255, 255, 255, 0.06); }
.cdw-seg button.cdw-on { background: rgba(248, 208, 48, 0.25); color: var(--cdw-gold); }
.cdw-chips { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.cdw-chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 1px 4px 0 9px;
  background: var(--cdw-panel-2); border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 99px;
}
.cdw-x {
  width: 18px; height: 18px; display: inline-grid; place-items: center; padding: 0; cursor: pointer;
  border: none; border-radius: 50%; background: transparent; color: var(--cdw-muted);
}
.cdw-x:hover { background: var(--cdw-edge); color: #fff; }
.cdw-moves { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
.cdw-move { position: relative; padding: 4px 26px 3px 8px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.22); background: var(--cdw-panel-2); }
.cdw-move small { display: block; color: var(--cdw-dim); font-size: 13px; }
.cdw-move .cdw-x { position: absolute; top: 3px; right: 3px; }
.cdw-move.cdw-empty { color: var(--cdw-dim); border-style: dashed; background: transparent; }
.cdw-ivs { display: flex; flex-wrap: wrap; gap: 6px; }
.cdw-ivs label { display: flex; flex-direction: column; align-items: center; font-size: 13px; color: var(--cdw-muted); }
.cdw-ivs input { width: 40px; text-align: center; padding: 1px 0 0; }
.cdw-pick { position: relative; display: inline-block; }
.cdw-pick > input { width: 220px; }
.cdw-menu {
  position: absolute; z-index: 5; top: calc(100% + 3px); left: 0; width: max(100%, 300px); max-height: 320px; overflow-y: auto;
  padding: 3px; background: #241d2e; border: 1px solid var(--cdw-edge); border-radius: 6px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.cdw-menu button {
  display: flex; justify-content: space-between; gap: 10px; width: 100%; padding: 3px 8px 2px; text-align: left;
  background: transparent; border: none; border-radius: 4px; cursor: pointer;
}
.cdw-menu button small { color: var(--cdw-dim); font-size: 14px; white-space: nowrap; }
.cdw-menu button.cdw-hi, .cdw-menu button:hover { background: rgba(221, 87, 72, 0.35); }
.cdw-menu .cdw-fits small { color: var(--cdw-blue); }
.cdw-menu .cdw-more { color: var(--cdw-dim); font-size: 14px; padding: 3px 8px; }
.cdw-catalog { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 10px; margin-top: 8px; padding: 8px; background: #241d2e; border: 1px solid var(--cdw-line); border-radius: 8px; }
.cdw-families button {
  display: flex; justify-content: space-between; width: 100%; padding: 2px 8px 1px; margin-bottom: 2px; text-align: left;
  cursor: pointer; color: var(--cdw-muted); background: transparent; border: 1px solid transparent; border-radius: 5px;
}
.cdw-families button small { color: var(--cdw-dim); font-size: 14px; }
.cdw-families button:hover { border-color: var(--cdw-line); }
.cdw-families button.cdw-on { background: rgba(221, 87, 72, 0.3); border-color: var(--cdw-edge); color: var(--cdw-text); }
.cdw-cat-head { display: flex; flex-wrap: wrap; gap: 6px; justify-content: space-between; align-items: center; margin-bottom: 6px; color: var(--cdw-gold); }
.cdw-items { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 5px; max-height: 360px; overflow-y: auto; padding-right: 4px; }
.cdw-item { padding: 3px 8px 2px; border-radius: 6px; cursor: pointer; text-align: left; background: var(--cdw-panel); border: 1px solid var(--cdw-line); }
.cdw-item small { display: block; color: var(--cdw-dim); font-size: 13px; }
.cdw-item:hover { border-color: var(--cdw-edge); }
.cdw-item.cdw-fits { border-color: rgba(104, 168, 248, 0.6); }
.cdw-item.cdw-fits small { color: var(--cdw-blue); }
.cdw-info { margin-bottom: 8px; padding: 4px 8px 3px; border-radius: 6px; background: rgba(104, 168, 248, 0.12); border: 1px solid rgba(104, 168, 248, 0.5); color: var(--cdw-muted); font-size: 15px; }
.cdw-count { margin-left: auto; color: var(--cdw-dim); font-size: 15px; }
.cdw-table { width: 100%; border-collapse: collapse; font-size: 16px; }
.cdw-table td { padding: 3px 6px; border-top: 1px solid var(--cdw-line); }
.cdw-table td:first-child { color: var(--cdw-gold); white-space: nowrap; }
.cdw-table td:last-child { text-align: right; white-space: nowrap; }
.cdw-enemy { display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; gap: 4px 12px; align-items: center; margin-bottom: 10px; }
.cdw-enemy .cdw-icon-big { grid-row: span 2; width: 56px; height: 42px; }
.cdw-list { display: flex; flex-direction: column; gap: 5px; }
.cdw-entry {
  display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 6px; align-items: start;
  padding: 5px 8px 4px; border-radius: 6px; background: var(--cdw-panel); border: 1px solid var(--cdw-line); font-size: 16px;
}
.cdw-entry small { display: block; color: var(--cdw-dim); font-size: 13px; }
.cdw-entry.cdw-pending { border-color: rgba(248, 208, 48, 0.55); }
.cdw-entry.cdw-pending .cdw-ico, .cdw-entry.cdw-sent .cdw-ico { color: var(--cdw-gold); }
.cdw-entry.cdw-applied .cdw-ico { color: var(--cdw-green); }
.cdw-entry.cdw-new { animation: cdw-flash 0.9s ease-out; }
@keyframes cdw-flash { from { background: rgba(248, 208, 48, 0.35); } to { background: var(--cdw-panel); } }
@media (prefers-reduced-motion: reduce) { .cdw-entry.cdw-new { animation: none; } .cdw-sw i::after { transition: none; } }
.cdw-empty { color: var(--cdw-dim); font-size: 15px; padding: 2px; }
.cdw-plan { display: flex; flex-direction: column; gap: 6px; width: 100%; min-width: 0; }
.cdw-planhead { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.cdw-planhead > .cdw-btn:last-child { margin-left: auto; }
.cdw-hint.cdw-inline { margin-top: 0; }
.cdw-mini { color: var(--cdw-gold); font-size: 14px; min-width: 22px; }
.cdw-ecols { display: grid; grid-template-columns: repeat(auto-fill, minmax(max(300px, calc(50% - 4px)), 1fr)); gap: 8px; align-items: start; }
.cdw-ecol { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 6px 8px; background: var(--cdw-win); border: 1px solid var(--cdw-line); border-radius: 8px; }
.cdw-ecol.cdw-set { border-color: rgba(248, 208, 48, 0.45); }
.cdw-ecol-h { display: flex; align-items: center; gap: 6px; color: var(--cdw-gold); font-size: 16px; }
.cdw-ecol-h .cdw-x { margin-left: auto; }
.cdw-ecol .cdw-icon { grid-row: auto; }
.cdw-icon-none { display: inline-block; border: 1px dashed var(--cdw-line); border-radius: 4px; }
.cdw-morebtn { align-self: flex-start; padding: 0 2px; background: transparent; border: none; color: var(--cdw-dim); cursor: pointer; font-size: 15px; }
.cdw-morebtn:hover { color: var(--cdw-text); }
.cdw-morebox { display: flex; flex-direction: column; gap: 4px; padding-top: 5px; border-top: 1px dashed var(--cdw-line); }
.cdw-morebox .cdw-mini { min-width: 86px; }
.cdw-seg button.cdw-s1, .cdw-seg button.cdw-s1.cdw-on { color: var(--cdw-gold); }
.cdw-seg button.cdw-s2, .cdw-seg button.cdw-s2.cdw-on { color: var(--cdw-blue); }
.cdw-seg button.cdw-s3, .cdw-seg button.cdw-s3.cdw-on { color: var(--cdw-red); }
.cdw-sum { margin: 2px 0 0; }
.cdw-gap { height: 12px; flex: none; }
.cdw-foot { margin-top: auto; padding-top: 10px; }
.cdw-section-h { margin: 14px 0 6px; color: var(--cdw-gold); border-bottom: 1px solid var(--cdw-line); }
.cdw-disconnected { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(29, 24, 38, 0.9); }
.cdw-disconnected div {
  display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-radius: 8px;
  background: rgba(240, 88, 72, 0.15); border: 1px solid var(--cdw-red); font-size: 20px;
}
.cdw-disconnected div::before { content: ""; width: 12px; height: 12px; border-radius: 50%; background: var(--cdw-red); }
@media (max-width: 1100px) {
  .cdw-cols { grid-template-columns: 220px minmax(0, 1fr); }
  .cdw-log { grid-column: 1 / -1; border-left: none; border-top: 1px solid var(--cdw-line); max-height: 40vh; }
}
`;
}

/** The page of the debug window before the game fills it (its own document, so the window's look is all its own) */
export function debugWindowPage(title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0;background:#1d1826"></body></html>`;
}
