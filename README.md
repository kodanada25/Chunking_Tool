# Chunking Tool — Browser Extension

A Chrome / Edge side-panel extension that splits large blocks of text into byte-sized chunks (≤ 3.5 KB each), designed for pasting into character-limited fields such as case comments.

---

## Table of Contents

- [Features](#features)
- [Architecture Overview](#architecture-overview)
- [File Structure](#file-structure)
- [How It Works](#how-it-works)
  - [User Flow](#user-flow)
  - [Data Flow](#data-flow)
  - [Pixel ↔ Character Mapping](#pixel--character-mapping)
  - [Content Transformation](#content-transformation)
  - [Session Persistence](#session-persistence)
- [Permissions](#permissions)
- [Internationalization (i18n)](#internationalization-i18n)
- [Accessibility](#accessibility)
- [Development](#development)
  - [Local Installation](#local-installation)
  - [Running Tests](#running-tests)
- [Privacy](#privacy)
- [License](#license)

---

## Features

| Feature | Description |
|---|---|
| **Visual Text Slicing** | Drag handles over pasted text to define chunk boundaries at exact byte sizes |
| **Live Size Feedback** | Real-time byte / character count updates as you drag |
| **3.5 KB Hard Cap** | Prevents any chunk from exceeding the byte limit |
| **Smart Cut Validation** | Cuts are only allowed at line breaks or sentence boundaries—never mid-word |
| **Multi-Handle Editing** | All locked cut handles remain draggable; resize any chunk at any time |
| **Chunk Tray** | Slide-up panel to review, expand, and copy individual or all chunks |
| **Approval Requests** | One-click copy of a pre-formatted approval request for each chunk |
| **Session Restore** | Work is persisted to `chrome.storage.local` and restored when the panel reopens |
| **Auto-Clear** | Session data is automatically purged after 2 hours of inactivity |
| **i18n** | Full localization support (English & Japanese) |
| **Keyboard Accessible** | Arrow / Page key navigation for handles; focus trap and Escape-to-close on the tray |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                      Chrome / Edge Browser                   │
│  ┌────────────────┐       ┌─────────────────────────────┐    │
│  │  background.js │──────▶│       Side Panel             │    │
│  │ (Service Worker)│       │  ┌───────────────────────┐  │    │
│  │                │       │  │   sidepanel.html       │  │    │
│  │ Opens side     │       │  │   ┌───────────────┐    │  │    │
│  │ panel on       │       │  │   │  styles.css   │    │  │    │
│  │ action click   │       │  │   └───────────────┘    │  │    │
│  └────────────────┘       │  │   ┌───────────────┐    │  │    │
│                           │  │   │ slicer-core.js│◄───┤──┤──── Pure logic (testable)
│                           │  │   └───────┬───────┘    │  │    │
│                           │  │           │            │  │    │
│                           │  │   ┌───────▼───────┐    │  │    │
│                           │  │   │   slicer.js   │    │  │    │
│                           │  │   │  (UI + State) │    │  │    │
│                           │  │   └───────┬───────┘    │  │    │
│                           │  │           │            │  │    │
│                           │  │    chrome.storage      │  │    │
│                           │  │      .local            │  │    │
│                           │  └───────────────────────┘  │    │
│                           └─────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

The extension follows a **two-layer architecture**:

1. **`slicer-core.js`** — A pure-logic module (IIFE) exposing testable functions with zero DOM or browser API dependencies. It handles byte formatting, line/boundary detection, content transformation, and segment computation.

2. **`slicer.js`** — The UI controller that owns all DOM interaction, drag handling, rendering, clipboard operations, session management, and i18n. It delegates computation to `SlicerCore`.

---

## File Structure

```
content-slicer-sidepanel/
├── manifest.json          # Manifest V3 — declares permissions, service worker, side panel
├── background.js          # Service worker — opens side panel on toolbar icon click
├── sidepanel.html         # Side panel UI shell (header, toolbar, textarea, overlay, tray)
├── styles.css             # All styles: layout, handles, tray, toast, segment bands
├── slicer-core.js         # Pure logic module (fmtB, isOnBlankLine, transformContent, getSegments)
├── slicer.js              # UI controller — drag engine, rendering, i18n, session, clipboard
├── package.json           # Dev config — test script
├── _locales/
│   ├── en/messages.json   # English strings
│   └── ja/messages.json   # Japanese strings
├── tests/
│   └── test-core.js       # Unit tests for slicer-core.js (Node.js test runner)
├── CHANGELOG.md           # Version history
├── PRIVACY_POLICY.md      # Data handling documentation
├── icon16.png             # Toolbar icon (16×16)
├── icon48.png             # Extension management icon (48×48)
└── icon128.png            # Chrome Web Store icon (128×128)
```

---

## How It Works

### User Flow

```
Paste Text  ──▶  Drag Handle Down  ──▶  "Add Cut" ──▶  Repeat  ──▶  "View Chunks"  ──▶  Copy
    │                   │                    │               │              │
    ▼                   ▼                    ▼               ▼              ▼
 textarea         overlay renders      cut is locked    next chunk     tray opens with
 becomes          colored band +       if on a blank    auto-sized     transformed
 read-only        live KB badge        line boundary    to ~3.2 KB     chunks to copy
```

1. **Paste** — User pastes text into the `<textarea>`. The textarea becomes read-only and a translucent overlay is rendered on top of it.
2. **Drag** — A white "active handle" appears. Dragging it downward extends a colored band that shows the byte size of the current chunk in real time.
3. **Add Cut** — Clicking "Add Cut" locks the current chunk boundary (only allowed at line breaks or sentence-ending punctuation). A new handle appears for the next chunk, pre-positioned at ~3.2 KB.
4. **Repeat** — The user continues slicing until all content is covered.
5. **View Chunks** — Opens a slide-up tray showing each chunk with its transformed content (report headers injected), ready to copy individually or all at once.

### Data Flow

The extension maintains two parallel coordinate systems — **pixel positions** (for rendering) and **character indices** (canonical source of truth):

```
                        ┌──────────┐
   User drags handle ──▶│ Pixel Pos│──▶ pxToChar() ──▶ Character Index
                        └──────────┘                        │
                                                            ▼
                        ┌──────────┐              ┌─────────────────┐
   Overlay rendered  ◀──│ Pixel Pos│◀── charToDocY│  cutChars[]     │
                        └──────────┘              │  activeBottomChar│
                                                  └────────┬────────┘
                                                           │
                                     getSegments() ◀───────┘
                                           │
                                           ▼
                                   Array of { bytes, chars, content }
```

**State variables:**

| Variable | Type | Description |
|---|---|---|
| `text` | `string` | The full pasted text content |
| `cuts` | `number[]` | Pixel positions of locked cut handles (sorted ascending) |
| `cutChars` | `number[]` | Character indices corresponding to each cut (canonical) |
| `activeBottomPx` | `number` | Pixel position of the active (unlocked) handle |
| `activeBottomChar` | `number` | Character index of the active handle (canonical) |

### Pixel ↔ Character Mapping

Because the textarea wraps text depending on panel width, pixel positions don't map linearly to character indices. The extension uses a **hidden mirror `<div>`** that clones the textarea's computed styles (font, padding, word-wrap, etc.):

1. **`charToDocY(charIdx)`** — Uses `Range` API on the mirror's text node to get the Y coordinate of any character.
2. **`pxToChar(docY)`** — Binary-searches the character range to find the character at a given Y position.

On **panel resize**, the `ResizeObserver` recalculates pixel positions from the canonical character indices, preventing state drift.

### Content Transformation

When chunks are exported, `SlicerCore.transformContent()` optionally injects structured headers:

- **Chunk 1** — If the text contains a known trigger line (a specific Japanese greeting), it's replaced with a header that includes the total chunk count.
- **Chunks 2+** — A numbered report header (e.g. `【ご報告2】`) is prepended.
- **Fallback** — If the trigger line is not detected, simple numbered headers are used.

### Session Persistence

```
render() ──▶ saveSession() ──▶ chrome.storage.local.set({
                                   text, cutChars, activeBottomChar, savedAt
                               })

window.load ──▶ restoreSession() ──▶ chrome.storage.local.get()
                                          │
                                          ▼
                                  validateSessionData()
                                          │
                                  if savedAt > 2h ago → discard
                                  else → rebuild UI from char indices
```

- Sessions are saved on every `render()` call (i.e., every drag movement or cut action).
- On restore, character indices are converted back to pixel positions via the mirror `<div>`.
- A 2-hour inactivity timer auto-clears session data.

---

## Permissions

| Permission | Reason |
|---|---|
| `sidePanel` | Registers the extension as a Chrome Side Panel |
| `storage` | Persists session data locally via `chrome.storage.local` |
| `clipboardWrite` | Enables copying chunk text to the system clipboard |

No network requests are made. No remote APIs are used. No data leaves the device.

---

## Internationalization (i18n)

The extension uses Chrome's `_locales/` system (Manifest V3 `__MSG_key__` tokens) and a runtime fallback:

- **Static strings** (`data-i18n` attributes on HTML elements) are localized at startup via `localizeUI()`.
- **Dynamic strings** (toasts, tray labels) use the `msg(key, subs)` helper, which:
  1. Checks a manually-loaded locale file (for Edge/Windows where `chrome.i18n.getUILanguage()` may differ from `navigator.language`).
  2. Falls back to `chrome.i18n.getMessage()`.
  3. Returns the raw key as a last resort.

**Supported locales:** English (`en`), Japanese (`ja`).

---

## Accessibility

- All drag handles have `role="slider"`, `aria-label`, `aria-valuenow`, `aria-valuemin/max`, and `aria-roledescription`.
- Handles support **keyboard navigation**: `Arrow Up/Down` (20px step), `Page Up/Down` (100px step), `Delete/Backspace` (remove cut).
- The chunks tray has `role="dialog"`, `aria-modal="true"`, and implements a **focus trap** with `Escape` to close.
- Delete buttons on cut handles and tray elements have descriptive `aria-label` attributes.
- Toast notifications use `role="status"` and `aria-live="polite"`.

---

## Development

### Local Installation

1. Clone the repository.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project directory.
5. Click the extension icon in the toolbar — the side panel opens.

### Running Tests

```bash
npm test
```

This runs the `slicer-core.js` unit tests using Node.js's built-in test runner:

```
node --test tests/test-core.js
```

Tests cover: `fmtB` (byte formatting), `getLine`, `isOnBlankLine` (boundary detection), `transformContent` (header injection), and `getSegments` (chunk computation).

---

## Privacy

All data processing happens **entirely within the browser**. No external servers, analytics, or third-party services are used. Session data is stored locally and auto-expires after 2 hours. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md) for full details.

---

## Author

**Ritwiz Mulay**

---
