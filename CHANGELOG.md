# Changelog

All notable changes to the CECT-C Chunking Tool will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.3] - 2026-03-25

### Added

- **Localization**: Full i18n support via `_locales/` (English and Japanese)
- **Accessibility**: ARIA attributes on drag handles, delete buttons, and tray; keyboard navigation for handle repositioning (Arrow/Page keys); focus trap and Escape-to-close on the chunks tray
- **Error handling**: `restoreSession()` validates stored data and wraps restoration in try/catch; `saveSession()` handles storage quota errors gracefully
- **Auto-clear**: Session data is automatically purged after 2 hours of inactivity
- **Privacy policy**: `PRIVACY_POLICY.md` documenting data handling practices
- **Unit tests**: Test suite for core logic functions (`fmtB`, `isOnBlankLine`, `transformContent`, `getSegments`, `getLine`)
- **Changelog**: This file

### Changed

- Extracted pure logic functions into `slicer-core.js` for testability
- Hardcoded Japanese strings replaced with `chrome.i18n.getMessage()` calls

## [2.2] - Previous Release

### Features

- Side panel UI for splitting large text into ≤ 4 KB chunks
- Drag handles for visual chunk boundary adjustment
- Session persistence via `chrome.storage.local`
- Copy individual or all chunks to clipboard
- Automatic content transformation with report headers
