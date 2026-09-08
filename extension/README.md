# modSUTD browser extension

A small Chrome / Edge extension (MV3) that injects a "share this review on modSUTD" button on SUTD term-end evaluation pages.

## Install (developer mode)

1. Open Chrome → `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** → pick this `extension/` directory.

You'll see the modSUTD icon in your extensions tray. Pin it.

## What it does

- On Microsoft Forms pages and `*.sutd.edu.sg` pages, watches the DOM for the "your response was submitted" confirmation message.
- When detected on a page that looks like a SUTD course evaluation, floats a button at the bottom-right that links to `https://modsutd.tech/share`.
- Clicking the button opens the share page in a new tab. The user pastes their review there manually (privacy default - see below).

## Privacy

By design, **the extension does not read or transmit your evaluation answers**. The MS Forms submit-then-clear pattern means the thank-you page literally doesn't have the text anymore, and we deliberately don't intercept the form before submit. If we ever add that, it'll be opt-in per form.

The only data the extension stores is your preferred site origin (in `chrome.storage.sync`), which lives on your Google account, not on any server.

## Files

```
extension/
├── manifest.json           MV3 manifest
├── content.js              detects eval pages, injects FAB
├── content.css             FAB styling
├── popup/popup.html|.js    toolbar popup with one CTA
├── options/options.html    site-origin override
└── icons/                  16/48/128 PNGs (TODO - placeholder pixels for now)
```

## TODO

- [ ] **Icons** - drop a real `icons/icon-16.png`, `icon-48.png`, `icon-128.png`. Match the abyssal palette (cyan glow on near-black).
- [ ] **Submit-side capture** (opt-in) - capture the user's answers as they type, store locally, offer them on the thank-you page. Needs a per-form whitelist + clear UI consent.
- [ ] **Firefox / Safari builds** - manifest is MV3-compatible but needs `applications.gecko` for Firefox and a different bundle for Safari.
- [ ] **Chrome Web Store listing** - once the icons + screenshots are ready, publish to the store so people don't have to install in dev mode.

## Distribution

While the extension is unpublished, link to a packaged `.zip` from the modSUTD `/contribute` page. Once published to the Chrome Web Store, swap the link to `chrome://extensions/?id=<id>`.

## Reload policy

Manifest permissions are scoped to `forms.office.com` and `*.sutd.edu.sg`. If SUTD ever moves the eval to a different host (e.g. Qualtrics, Google Forms), update `content_scripts.matches` and `host_permissions` in `manifest.json` and republish.
