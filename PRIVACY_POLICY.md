# Privacy Policy — Chunking Tool

**Effective Date:** 2026-03-25
**Last Updated:** 2026-03-25

## Overview

Chunking Tool is a Chrome extension that helps users split large text content into smaller chunks for pasting into character-limited fields. This policy describes how the extension handles user data.

## Data Collection

This extension does **not** collect, transmit, or share any personal data or user content with external servers. All processing occurs entirely within the user's browser.

## Local Storage

The extension uses `chrome.storage.local` to persist the current editing session (pasted text and cut positions) so that work is not lost when the side panel is closed. This data:

- Is stored **only** on the user's device
- Is **never** sent to any external server or third party
- Is **automatically cleared** after 2 hours of inactivity
- Can be **manually cleared** at any time using the "Refresh" button

## Permissions

| Permission       | Purpose                                    |
|------------------|--------------------------------------------|
| `sidePanel`      | Display the tool in Chrome's side panel    |
| `storage`        | Persist session state locally              |
| `clipboardWrite` | Copy chunked text to the clipboard         |

## Data Retention

Session data is automatically purged after **2 hours** from the time it was last saved. Users may also clear all stored data immediately by clicking the **Refresh** button within the extension.

## Third-Party Services

This extension does not integrate with any third-party services, analytics platforms, or remote APIs.

## Changes to This Policy

Any changes to this privacy policy will be documented in the project's CHANGELOG.md and reflected by an updated "Last Updated" date above.

## Contact

For questions regarding this privacy policy or the extension's data handling practices, contact the extension author.
