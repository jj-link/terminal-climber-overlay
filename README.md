# Terminal Climber

Terminal Climber is a transparent, always-on-top Windows desktop pet that climbs the visible text in the foreground terminal. It treats contiguous text spans as handholds, follows them while output scrolls, and falls when the cursor knocks it loose or the text moves too quickly.

## Requirements

- Windows 11 x64
- Node.js and npm
- A non-elevated Windows Terminal, OpenConsole, or classic Console Host window

Third-party terminal emulators and elevated terminals are intentionally unsupported.

## Install and run

```powershell
npm install
npm run overlay
```

The overlay starts in mouse-passthrough mode, so terminal input remains uninterrupted. Press `Ctrl+Shift+O` to make its controls interactive.

If another application claims one of the global shortcuts, the overlay will
report the conflict at startup and leave mouse interaction enabled so the
on-screen controls remain reachable. Only one overlay instance runs at a time;
subsequent launch attempts restore or reveal the existing window. When mouse
passthrough is enabled, the overlay remains inactive so terminal focus is not
stolen.

For development with Vite and Electron:

```powershell
npm run overlay:dev
```

## Controls

| Action | Shortcut |
| --- | --- |
| Toggle mouse passthrough | `Ctrl+Shift+O` |
| Pause or resume | `Ctrl+Alt+Shift+P` |
| Reset the climber | `Ctrl+Alt+Shift+R` |

The expanded status capsule also provides pause, reset, passthrough, and close buttons.

## Behavior

- Only the foreground supported terminal supplies handholds.
- Each contiguous non-whitespace span has its own hold geometry; the gaps between words are not climbable.
- Blank rows are tracked for scroll reconciliation but cannot be climbed.
- The climber launches from the display floor, uses both hands on wide text spans, and braces with one hand on narrow spans.
- A short lookahead prefers a reachable hold that keeps a route open instead of greedily choosing a dead end.
- Ordinary scrolling carries each anchored hand with its row.
- A removed row or redraw causes a fall. A fast output burst first lets one hand slip; a continuing burst releases the second hand and falls.
- When an attached row exits above the terminal viewport, the climber re-enters from the top of the physical display, falls to the display floor, lands, and restarts.
- Only a stable, topmost terminal row counts as a summit. There the climber mantles onto the text, plants a flag, and camps; a newly confirmed handhold makes it pack up and resume climbing.
- A fast cursor sweep makes one hand slip when the other can brace; the climber recovers on the hold. A one-handed climber falls on a fast strike. The campsite is cleared when its row disappears, the terminal target changes, or the climber is reset.
- Resetting the climber while paused preserves the paused state; use the pause toggle to resume from the grounded baseline.
- Focusing a nonterminal window for more than 500 ms releases the climber and leaves it pacing at the display bottom until tracking resumes.

## Terminal access and privacy

Terminal geometry comes from Windows UI Automation in a dedicated worker thread. The worker reads each visible row only long enough to derive its text-span geometry and generate session-scoped HMAC signatures. Raw terminal text and the HMAC key never cross worker IPC, are never logged or persisted, and are discarded after each sample. The app does not use screenshots, OCR, shell hooks, or terminal-history files.

## Verification

Run the automated behavior suite and production build:

```powershell
npm test
npm run build
```

To verify live UI Automation access, focus a supported terminal with at least three nonblank rows and run:

```powershell
npm run probe:uia
```

A successful probe prints only tracking status, an anonymous target identifier, the attachable-row count, and sample rectangles. It never prints terminal content.

## Project structure

- `electron/uia-bindings.cjs` — Koffi bindings for Windows UI Automation and native process/window APIs.
- `electron/terminal-uia-worker.cjs` — foreground-terminal polling, row geometry, hashing, and COM lifetime management.
- `electron/global-controls.cjs` — global-shortcut registration with conflict detection and safe fallbacks.
- `electron/main.cjs` — overlay window, worker lifecycle, display conversion, single-instance guard, and sanitized IPC.
- `electron/preload.cjs` — narrow context-isolated renderer API.
- `src/row-tracker.ts` — anonymous row/segment reconciliation and scroll/redraw detection.
- `src/climber.ts` — deterministic climber physics, state transitions, collision handling, and canvas rendering.
- `src/main.ts` — renderer wiring, observable status, and controls.
- `src/assets/climber-sprites.svg` — 32-frame pixel-art atlas, including summit and campsite poses.
- `tests/` — row-tracking and climber behavior tests.
