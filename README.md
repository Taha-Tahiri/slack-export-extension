# Slack Export

A Chrome extension that exports Slack conversations — channels, DMs, and group chats — with full message history, threads, reactions, and media files.

---

## Features

- **Full conversation export** — messages, threads, reactions, user mentions, and file attachments
- **Multiple formats** — export as JSON, styled HTML, or both
- **Media downloads** — save images and files locally alongside the export
- **Slack-accurate HTML** — dark theme export that mirrors Slack's native UI with search functionality
- **Smart pagination** — handles conversations of any size with cursor-based fetching
- **Progress tracking** — real-time progress that persists even if you switch tabs
- **Estimation** — preview message and media counts before starting an export
- **One-click export** — just open a Slack conversation and click Export

---

## Installation

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `slack-export` folder
5. Navigate to any Slack conversation and click the extension icon

---

## Usage

1. Open a Slack channel, DM, or group conversation in your browser
2. Click the **Slack Export** extension icon in the toolbar
3. Select your export options:
   - **JSON** — structured data with all message metadata
   - **HTML** — styled, searchable conversation view
   - **Media** — download images and files locally
4. *(Optional)* Click **Estimate** to preview the export size
5. Click **Export** to start

Exports are saved to your Downloads folder as `{conversation-name}_{timestamp}/`.

---

## Export Formats

### JSON

Complete structured data including:
- All messages with timestamps and user info
- Thread replies
- Reactions with user lists
- File metadata and URLs
- User profile map

### HTML

Self-contained HTML file with:
- Slack dark theme styling
- Color-coded user avatars
- Threaded replies with summary indicators
- Inline images and file cards
- Emoji rendering
- Full-text search with keyboard navigation (`Enter` / `Shift+Enter` / `Escape`)

---

## File Structure

```
slack-export/
├── manifest.json       Extension manifest (MV3)
├── content-api.js      Content script — token extraction & Slack API calls
├── background.js       Service worker — export generation & media downloads
├── emoji-map.js        Emoji code-to-Unicode mapping
├── popup.html          Extension popup markup
├── popup.css           Popup styles
├── popup.js            Popup logic
└── icons/
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```

---

## Permissions

| Permission | Purpose |
|---|---|
| `activeTab` | Access the current Slack tab to extract data |
| `storage` | Persist export options and progress state |
| `downloads` | Save exported files to the Downloads folder |

The extension only runs on `*.slack.com` pages. No data is sent to any external server.

---

## How It Works

1. **Token extraction** — reads your existing Slack session token from the page (localStorage, cookies, or boot data)
2. **API fetching** — calls Slack's internal APIs (`conversations.history`, `users.info`, `conversations.replies`) with cursor-based pagination
3. **Processing** — deduplicates messages, resolves user mentions, collects media URLs
4. **Export** — generates JSON/HTML files and downloads media through Chrome's download API

---

## Troubleshooting

| Issue | Solution |
|---|---|
| "Please open this extension on a Slack page" | Navigate to a Slack workspace URL first |
| Export fails immediately | Refresh the Slack page to ensure your session is active |
| Missing messages | Very large channels may take several minutes — check progress |
| Media not loading in HTML | Ensure the `media/` folder is in the same directory as the HTML file |

---

## License

MIT
