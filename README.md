# ProjectTray

A tray-first project dashboard for macOS. ProjectTray lives in the menu bar and
drops a calm, full-screen overlay over whatever you are doing — including a
fullscreen app — so the next actions are always one click away.

| Dark | Light |
| --- | --- |
| ![ProjectTray overlay in dark mode](assets/projecttray-preview.png) | ![ProjectTray overlay in light mode](assets/projecttray-preview-light.png) |

## What works in this prototype

- Menu bar-only app (no Dock icon), with a custom template tray icon.
- Left-click the tray icon to show or hide the overlay. Right-click for
  **Open ProjectTray** and **Quit**.
- Full-screen overlay that joins all macOS Spaces and uses a
  `FullScreenAuxiliary` window so it can appear over fullscreen apps.
- The overlay sits one level above the Dock, so the Dock stays behind the UI
  instead of covering it. The menu bar stays reachable, so the tray icon can
  still toggle the overlay.
- Native macOS vibrancy provides the blur behind the overlay without the
  in-and-out flicker of a CSS `backdrop-filter`.
- Dark and light themes, switchable with the sun/moon button in the header.
  The choice is saved with the rest of the state.
- Square project cards with editable names, card colors, and inline task lists.
- Tasks can be completed, renamed, deleted, and given a due date with a custom
  calendar picker.
- Add projects and next actions without leaving the overlay.
- Project menus support recoloring, clearing completed tasks, and deleting with
  undo.
- All state is saved locally as JSON by the Rust backend.
- `Esc` or a click on the dimmed backdrop closes the overlay.
- `⌘N` adds a new project.

## Permissions

ProjectTray does **not** need Accessibility, Screen Recording, or Full Disk
Access. The fullscreen behavior comes from native AppKit window ordering and
collection behavior inside the app itself, not from system automation. If you
granted ProjectTray Accessibility access while troubleshooting an earlier
build, you can remove it.

## Run it

Requirements: macOS 12+, Xcode Command Line Tools, Node.js, and Rust.

```bash
npm install
npm run dev
```

The first launch opens the overlay automatically so you can see it. After that,
ProjectTray starts hidden in the menu bar. Left-click the tray icon to open the
overlay, and right-click it for **Open ProjectTray** or **Quit**.

To make a release build:

```bash
npm run build
```

The `.app` and `.dmg` are written under `src-tauri/target/release/bundle/`.

## Where the data lives

```text
~/Library/Application Support/com.projecttray.app/projecttray.json
```

The file is written atomically by the Rust side whenever the UI changes. Delete
it while ProjectTray is closed to start over with the sample projects. The file
also stores the selected `theme` (`"dark"` or `"light"`); older state files
without a theme fall back to the macOS system appearance.

## How it is put together

- **Rust / Tauri 2** — application lifecycle, menu bar item, global window
  behavior, overlay sizing, local persistence, and theme changes.
- **AppKit bridge** — a small amount of Objective-C interop via `objc2-app-kit`
  to apply the `Accessory` activation policy before the window exists, set the
  window just above the Dock, and opt into all Spaces and fullscreen auxiliaries.
- **Native vibrancy** — Tauri's `set_effects` applies the
  `UnderWindowBackground` material, so the blur is rendered by macOS and stays
  steady instead of being repainted by the WebView.
- **WebView UI** — dependency-free HTML, CSS, and JavaScript for fast iteration
  on the visual layer. Tauri still owns the native shell and data layer.

The overlay is a transparent, borderless window that is resized to the display
under the cursor each time it opens. The panel itself is rendered in the
WebView, which makes the interaction model easy to iterate on while keeping the
tray/fullscreen plumbing native.

## Known prototype limitations

- No global keyboard shortcut yet; the tray icon is the entry point.
- No drag-to-reorder, notifications, or sync.
- The build is unsigned and not notarized.
- Menu bar behavior is macOS-only by design.
