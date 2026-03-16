// Background service worker for coordinating export and downloads
import { EMOJI_MAP } from './emoji-map.js';

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'exportData') {
    handleExportData(message.data);
  } else if (message.action === 'extractionError') {
    notifyPopup('exportError', { error: message.error });
  } else if (message.action === 'progress') {
    // Persist progress so popup can restore on reopen
    chrome.storage.local.set({
      extractionState: { isExtracting: true, progress: message.message, startedAt: Date.now() }
    });
    notifyPopup('progress', { message: message.message });
  }
});

async function handleExportData(data) {
  try {
    const { exportOptions } = await chrome.storage.local.get('exportOptions');
    const options = exportOptions || { exportJson: true, exportHtml: true, downloadMedia: true };

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const safeName = sanitizeFileName(data.conversationName);
    const folderName = `${safeName}_${timestamp}`;

    if (options.exportJson) {
      await exportToJson(data, folderName);
    }

    if (options.exportHtml) {
      await exportToHtml(data, folderName, options.downloadMedia);
    }

    if (options.downloadMedia && data.media && data.media.length > 0) {
      await downloadMediaFiles(data.media, `${folderName}/media`);
    }

    // Clear extraction state from storage
    await chrome.storage.local.remove('extractionState');

    notifyPopup('exportComplete', {
      messageCount: data.messageCount,
      conversationName: data.conversationName,
      folderName
    });

  } catch (error) {
    console.error('Export error:', error);
    await chrome.storage.local.remove('extractionState');
    notifyPopup('exportError', { error: error.message });
  }
}

// --- JSON Export ---

async function exportToJson(data, folderName) {
  const jsonString = JSON.stringify(data, null, 2);
  const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonString);

  await chrome.downloads.download({
    url: dataUrl,
    filename: `${folderName}/export.json`,
    saveAs: false
  });
}

// --- HTML Export ---

async function exportToHtml(data, folderName, includeLocalMedia) {
  const html = generateHtml(data, includeLocalMedia);
  const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);

  await chrome.downloads.download({
    url: dataUrl,
    filename: `${folderName}/conversation.html`,
    saveAs: false
  });
}

function generateHtml(data, includeLocalMedia) {
  const messages = data.messages || [];
  const conversationName = escapeHtml(data.conversationName);
  const conversationType = data.conversationType;
  const userMap = data.userMap || {};

  // Assign consistent random colors per user
  const avatarColors = [
    '#E8912D', '#2BAC76', '#D32F2F', '#1565C0', '#6B3FA0',
    '#00838F', '#AD1457', '#4E342E', '#37474F', '#558B2F',
    '#F9A825', '#00695C', '#283593', '#BF360C', '#0277BD',
    '#7B1FA2', '#C62828', '#2E7D32', '#EF6C00', '#1976D2'
  ];
  const userColorMap = {};
  let colorIndex = 0;
  function getUserColor(username) {
    if (!userColorMap[username]) {
      // Use a hash of the username for deterministic color assignment
      let hash = 0;
      for (let i = 0; i < username.length; i++) {
        hash = ((hash << 5) - hash) + username.charCodeAt(i);
        hash = hash & hash;
      }
      userColorMap[username] = avatarColors[Math.abs(hash) % avatarColors.length];
    }
    return userColorMap[username];
  }

  // Build media map for local references
  const mediaMap = {};
  if (includeLocalMedia && data.media) {
    data.media.forEach(item => {
      mediaMap[item.url] = `media/${item.name}`;
    });
  }

  // Group messages by date
  const messagesByDate = {};
  messages.forEach(msg => {
    if (!msg || !msg.timestamp) return;
    try {
      const date = new Date(msg.timestamp).toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });
      if (!messagesByDate[date]) messagesByDate[date] = [];
      messagesByDate[date].push(msg);
    } catch (e) {
      console.error('Error processing message date:', e);
    }
  });

  let messagesHtml = '';
  for (const [date, msgs] of Object.entries(messagesByDate)) {
    messagesHtml += `<div class="date-separator"><span>${date}</span></div>`;

    msgs.forEach((msg, index) => {
      if (!msg) return;

      const author = escapeHtml(msg.user || 'Unknown');
      const text = convertSlackMarkdown(msg.text || '');
      let time = '';
      try {
        time = new Date(msg.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      } catch (e) { time = '--:--'; }

      const prevMsg = index > 0 ? msgs[index - 1] : null;
      const isGrouped = prevMsg && prevMsg.user === msg.user &&
        msg.timestamp && prevMsg.timestamp &&
        (new Date(msg.timestamp) - new Date(prevMsg.timestamp)) < 300000;

      const reactionsHtml = renderReactions(msg.reactions, userMap);
      const imagesHtml = renderFiles(msg.files, includeLocalMedia, mediaMap);
      const attachmentsHtml = renderAttachments(msg.attachments, includeLocalMedia, mediaMap);
      const threadHtml = renderThread(msg.replies, userMap, getUserColor);

      const color = getUserColor(msg.user || 'Unknown');
      const messageClass = isGrouped ? 'message message-grouped' : 'message';
      const avatarHtml = isGrouped ? '' : `<div class="avatar" style="background:${color}">${author.charAt(0).toUpperCase()}</div>`;
      const headerHtml = isGrouped ? '' : `
        <div class="message-header">
          <span class="author">${author}</span>
          <span class="timestamp">${time}</span>
        </div>`;

      messagesHtml += `
        <div class="${messageClass}">
          ${avatarHtml}
          <div class="message-content">
            ${headerHtml}
            <div class="message-text">${text}</div>
            ${imagesHtml}
            ${attachmentsHtml}
            ${reactionsHtml}
            ${threadHtml}
          </div>
        </div>`;
    });
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Slack Export - ${conversationName}</title>
  <style>${getHtmlStyles()}</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-content">
        <h1>${conversationName}</h1>
        <div class="meta">
          Type: ${conversationType} |
          Exported: ${new Date(data.extractedAt).toLocaleString('en-US')} |
          Messages: ${data.messageCount}
        </div>
      </div>
      <div class="search-bar">
        <input type="text" id="searchInput" placeholder="Search conversation..." />
        <div class="search-controls">
          <span id="searchResults" class="search-results">0 results</span>
          <button id="prevResult" class="search-btn" title="Previous result (Shift+Enter)">↑</button>
          <button id="nextResult" class="search-btn" title="Next result (Enter)">↓</button>
          <button id="clearSearch" class="search-btn" title="Clear">✕</button>
        </div>
      </div>
    </div>
    <div class="messages">${messagesHtml}</div>
    <div class="footer">Exported with Slack Export</div>
  </div>
  <script>${getSearchScript()}</script>
</body>
</html>`;
}

// --- HTML Sub-Renderers ---

function renderReactions(reactions, userMap) {
  if (!reactions || reactions.length === 0) return '';

  return '<div class="reactions">' +
    reactions.map(r => {
      const emoji = convertEmojiCodes(`:${r.name}:`);
      let userNames = [];
      if (r.users && Array.isArray(r.users)) {
        userNames = r.users.map(uid => {
          const u = userMap[uid];
          return u ? (u.display_name || u.real_name || u.name) : uid;
        });
      }
      const tooltip = userNames.length > 0 ? userNames.join(', ') : '';
      const titleAttr = tooltip ? `title="${escapeHtml(tooltip)}"` : '';
      return `<span class="reaction" ${titleAttr}>${emoji} ${r.count}</span>`;
    }).join('') +
    '</div>';
}

function renderFiles(files, includeLocalMedia, mediaMap) {
  if (!files || !Array.isArray(files) || files.length === 0) return '';

  return '<div class="images">' +
    files.filter(f => f).map(file => {
      try {
        const fileUrl = file.url_private || file.url_private_download || file.permalink || file.url;
        if (!fileUrl) return '';

        const isImage = file.mimetype?.startsWith('image/') || fileUrl?.includes('slack-imgs');
        if (isImage) {
          const useLocal = includeLocalMedia && mediaMap[fileUrl];
          const src = useLocal ? mediaMap[fileUrl] : fileUrl;
          const alt = file.name || file.title || '';
          const fileName = file.name || 'image';
          const isLocal = src && src.startsWith('media/');

          if (!includeLocalMedia) {
            return `
              <div class="image-container image-not-downloaded">
                <a href="${escapeHtml(fileUrl)}" target="_blank" class="image-placeholder" title="Click to open in Slack">
                  <div class="placeholder-content">
                    <div class="placeholder-icon">🖼️</div>
                    <div class="placeholder-text">${escapeHtml(fileName)}</div>
                    <div class="placeholder-hint">Click to view in Slack</div>
                  </div>
                </a>
              </div>`;
          }

          const downloadAttr = isLocal ? '' : `download="${escapeHtml(fileName)}"`;
          return `
            <div class="image-container">
              <a href="${escapeHtml(src)}" ${downloadAttr} target="_blank" class="image-link" title="Click to open ${escapeHtml(fileName)}">
                <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" />
                <div class="image-overlay">
                  <span class="download-icon">👁️ Open</span>
                </div>
              </a>
              <div class="image-name">${escapeHtml(fileName)}</div>
            </div>`;
        } else {
          const href = (includeLocalMedia && mediaMap[fileUrl]) ? mediaMap[fileUrl] : fileUrl;
          const name = file.name || file.title || 'File';
          const isLocal = href && href.startsWith('media/');
          const downloadAttr = isLocal ? '' : `download="${escapeHtml(name)}"`;
          return `<div class="file-link"><a href="${escapeHtml(href)}" ${downloadAttr} target="_blank">📄 ${escapeHtml(name)}</a></div>`;
        }
      } catch (e) { return ''; }
    }).join('') +
    '</div>';
}

function renderAttachments(attachments, includeLocalMedia, mediaMap) {
  if (!attachments || !Array.isArray(attachments) || attachments.length === 0) return '';

  return '<div class="attachments">' +
    attachments.filter(a => a).map(att => {
      try {
        if (att.image_url) {
          const src = (includeLocalMedia && mediaMap[att.image_url]) ? mediaMap[att.image_url] : att.image_url;
          const fileName = att.title || 'attachment';
          const isLocal = src && src.startsWith('media/');
          const downloadAttr = isLocal ? '' : `download="${escapeHtml(fileName)}"`;
          return `
            <div class="image-container">
              <a href="${escapeHtml(src)}" ${downloadAttr} target="_blank" class="image-link" title="Click to open ${escapeHtml(fileName)}">
                <img src="${escapeHtml(src)}" alt="${escapeHtml(att.title || '')}" loading="lazy" />
                <div class="image-overlay">
                  <span class="download-icon">👁️ Open</span>
                </div>
              </a>
              <div class="image-name">${escapeHtml(fileName)}</div>
            </div>`;
        } else {
          const fileName = escapeHtml(att.title || att.fallback || 'File');
          const fileUrl = att.url ? `href="${escapeHtml(att.url)}"` : '';
          const isLocal = att.url && att.url.startsWith('media/');
          const downloadAttr = (att.url && !isLocal) ? 'download' : '';
          return `<div class="attachment"><a ${fileUrl} ${downloadAttr} target="_blank">${fileName}</a></div>`;
        }
      } catch (e) { return ''; }
    }).join('') +
    '</div>';
}

function renderThread(replies, userMap, getUserColor) {
  if (!replies || replies.length === 0) return '';

  // Thread summary line (like Slack's "X replies" with avatars)
  const uniqueRepliers = [...new Set(replies.map(r => r.user || 'Unknown'))];
  const lastReply = replies[replies.length - 1];
  let lastReplyTime = '';
  try {
    lastReplyTime = new Date(lastReply.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch (e) { lastReplyTime = ''; }

  const replyAvatars = uniqueRepliers.slice(0, 3).map(user => {
    const color = getUserColor ? getUserColor(user) : '#6B3FA0';
    const initial = escapeHtml(user).charAt(0).toUpperCase();
    return `<div class="thread-avatar" style="background:${color}">${initial}</div>`;
  }).join('');

  let html = '<div class="thread">';
  html += `<div class="thread-summary">
    <div class="thread-avatars">${replyAvatars}</div>
    <span class="thread-reply-count">${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}</span>
    ${lastReplyTime ? `<span class="thread-last-reply">Last reply today at ${lastReplyTime}</span>` : ''}
  </div>`;
  html += '<div class="thread-messages">';

  replies.forEach(reply => {
    const author = escapeHtml(reply.user || 'Unknown');
    const text = convertSlackMarkdown(reply.text || '');
    let time = '';
    try {
      time = new Date(reply.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { time = '--:--'; }

    const color = getUserColor ? getUserColor(reply.user || 'Unknown') : '#6B3FA0';
    const reactionsHtml = renderReactions(reply.reactions, userMap);

    html += `
      <div class="thread-reply">
        <div class="avatar" style="background:${color}">${author.charAt(0).toUpperCase()}</div>
        <div class="message-content">
          <div class="message-header">
            <span class="author">${author}</span>
            <span class="timestamp">${time}</span>
          </div>
          <div class="message-text">${text}</div>
          ${reactionsHtml}
        </div>
      </div>`;
  });

  html += '</div></div>';
  return html;
}

// --- Slack Markdown Converter ---

function convertSlackMarkdown(text) {
  if (!text) return '';
  let html = text;

  // Links: <url|text> or <url>
  html = html.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (m, url, label) => {
    return `<a href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  });
  html = html.replace(/<(https?:\/\/[^>]+)>/g, (m, url) => {
    const safeUrl = url.replace(/"/g, '&quot;');
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
  });

  // Mailto links
  html = html.replace(/<mailto:([^|>]+)\|([^>]+)>/g, (m, email, label) => {
    return `<a href="mailto:${email}">${escapeHtml(label)}</a>`;
  });
  html = html.replace(/<mailto:([^>]+)>/g, (m, email) => {
    return `<a href="mailto:${email}">${email}</a>`;
  });

  // Escape remaining HTML entities (preserve our <a> tags)
  html = html.replace(/&(?!#?\w+;)/g, '&amp;');

  // Code blocks: ```code```
  html = html.replace(/```([^`]+)```/g, (m, code) => {
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  });

  // Inline code: `code`
  html = html.replace(/`([^`]+)`/g, (m, code) => {
    return `<code>${escapeHtml(code)}</code>`;
  });

  // Bold: *text*
  html = html.replace(/(?<!<[^>]*)\*([^*\n]+)\*(?![^<]*>)/g, '<strong>$1</strong>');

  // Italic: _text_
  html = html.replace(/(?<!<[^>]*)(?:^|[\s])_([^_\n]+)_(?=[\s]|$)(?![^<]*>)/g, (match, text) => {
    return match.startsWith(' ') ? ' <em>' + text + '</em>' : '<em>' + text + '</em>';
  });

  // Strikethrough: ~text~
  html = html.replace(/(?<!<[^>]*)~([^~\n]+)~(?![^<]*>)/g, '<del>$1</del>');

  // Blockquotes: > text
  html = html.replace(/^>\s*(.*)$/gm, '<blockquote>$1</blockquote>');

  // Emoji codes
  html = convertEmojiCodes(html);

  // Newlines
  html = html.replace(/\n/g, '<br>');

  return html;
}

function convertEmojiCodes(text) {
  return text.replace(/:([a-z0-9_+-]+):/g, (match, code) => {
    return EMOJI_MAP[code] || match;
  });
}

// --- Media Downloads ---

async function downloadMediaFiles(media, mediaFolderPath) {
  for (let i = 0; i < media.length; i++) {
    const item = media[i];
    try {
      notifyPopup('progress', {
        message: `Downloading media... (${i + 1}/${media.length})`
      });

      await chrome.downloads.download({
        url: item.url,
        filename: `${mediaFolderPath}/${item.name}`,
        saveAs: false
      });

      await sleep(200);
    } catch (error) {
      console.error(`Failed to download media: ${item.url}`, error);
    }
  }
}

// --- Utility Functions ---

function sanitizeFileName(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 100);
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function notifyPopup(action, data) {
  try {
    await chrome.runtime.sendMessage({ action, ...data });
  } catch (error) {
    // Popup might be closed
    console.log('Could not notify popup:', error.message);
  }
}

// --- HTML Styles (inline CSS for self-contained export) ---

function getHtmlStyles() {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #1A1D21; margin: 0; padding: 0; line-height: 1.46668; color: #D1D2D3;
    }

    .container { max-width: 100%; margin: 0; background: #1A1D21; min-height: 100vh; }

    .header {
      background: #1A1D21; border-bottom: 1px solid #49494D;
      padding: 16px 20px; position: sticky; top: 0; z-index: 100;
    }

    .header-content { margin-bottom: 12px; }
    h1 { color: #FFFFFF; font-size: 18px; font-weight: 900; margin-bottom: 2px; }
    .meta { color: #ABABAD; font-size: 13px; }

    .search-bar {
      display: flex; align-items: center; gap: 12px;
      background: #222529; border: 1px solid #565856;
      border-radius: 8px; padding: 6px 12px; transition: border-color 0.2s ease;
    }
    .search-bar:focus-within { border-color: #1D9BD1; }

    #searchInput {
      flex: 1; background: transparent; border: none; outline: none;
      color: #D1D2D3; font-size: 14px; font-family: inherit; padding: 4px 0;
    }
    #searchInput::placeholder { color: #616061; }

    .search-controls { display: flex; align-items: center; gap: 6px; }
    .search-results { color: #ABABAD; font-size: 13px; min-width: 70px; text-align: right; }

    .search-btn {
      background: transparent; border: 1px solid #565856; color: #D1D2D3;
      width: 28px; height: 28px; border-radius: 4px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; transition: all 0.1s ease; padding: 0;
    }
    .search-btn:hover:not(:disabled) { background: #2C2D30; border-color: #797C80; }
    .search-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .search-highlight { background: #F2C744; color: #1A1D21; padding: 2px 0; border-radius: 2px; }
    .search-highlight-active { background: #FF6B35; color: #FFFFFF; font-weight: 600; }

    .messages { padding: 0 20px 24px 20px; }

    .date-separator { position: relative; margin: 24px 0 16px 0; text-align: center; }
    .date-separator::before {
      content: ''; position: absolute; top: 50%; left: 0; right: 0;
      height: 1px; background: #49494D; z-index: 0;
    }
    .date-separator span {
      background: #1A1D21; padding: 4px 16px; border: 1px solid #49494D;
      border-radius: 24px; font-size: 13px; font-weight: 700;
      color: #E8E8E8; position: relative; z-index: 1;
      display: inline-block;
    }

    .message {
      display: flex; padding: 8px 20px; position: relative; transition: background 0.05s ease;
      gap: 8px;
    }
    .message:hover { background: #222529; }
    .message-grouped { padding-top: 0; padding-bottom: 0; }
    .message-grouped .message-content { padding-left: 44px; }
    .message-grouped:hover .grouped-time { opacity: 1; }

    .avatar {
      width: 36px; height: 36px; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 15px; color: #FFFFFF;
      flex-shrink: 0; user-select: none;
    }

    .message-content { flex: 1; min-width: 0; }
    .message-header { display: flex; align-items: baseline; gap: 8px; }
    .author { font-weight: 900; font-size: 15px; color: #E8E8E8; cursor: pointer; }
    .author:hover { text-decoration: underline; }
    .timestamp { color: #ABABAD; font-size: 12px; font-weight: 400; }

    .message-text {
      color: #D1D2D3; font-size: 15px; word-wrap: break-word;
      line-height: 1.46668;
    }
    .message-text a { color: #1D9BD1; text-decoration: none; }
    .message-text a:hover { text-decoration: underline; }
    .message-text strong { font-weight: 700; color: #E8E8E8; }
    .message-text em { font-style: italic; }
    .message-text del { text-decoration: line-through; opacity: 0.7; }
    .message-text code {
      background: #2C2D30; color: #E06C75; padding: 2px 5px; border-radius: 3px;
      font-family: 'Monaco', 'Menlo', 'Consolas', 'Courier New', monospace;
      font-size: 12px; border: 1px solid #49494D;
    }
    .message-text pre {
      background: #2C2D30; border: 1px solid #49494D; border-radius: 6px;
      padding: 12px; margin: 8px 0; overflow-x: auto;
    }
    .message-text pre code { background: transparent; border: none; padding: 0; color: #D1D2D3; font-size: 13px; }
    .message-text blockquote {
      border-left: 4px solid #49494D; margin: 4px 0; padding-left: 16px;
      color: #ABABAD;
    }

    /* Images & files */
    .images { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 12px; }
    .image-container { position: relative; display: inline-block; }
    .image-link { position: relative; display: block; cursor: pointer; text-decoration: none; }
    .image-link img {
      max-width: 360px; max-height: 300px; border-radius: 8px;
      border: 1px solid #49494D; display: block; transition: all 0.15s ease;
    }
    .image-link:hover img { border-color: #1D9BD1; }
    .image-overlay {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.45); display: flex; align-items: center;
      justify-content: center; opacity: 0; transition: opacity 0.15s ease; border-radius: 8px;
    }
    .image-link:hover .image-overlay { opacity: 1; }
    .download-icon {
      color: #FFFFFF; font-size: 13px; font-weight: 700; padding: 6px 14px;
      background: rgba(29, 28, 29, 0.85); border-radius: 6px;
    }
    .image-name {
      margin-top: 4px; font-size: 12px; color: #ABABAD;
      max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    .image-not-downloaded { max-width: 360px; }
    .image-placeholder {
      display: block; background: #222529; border: 1px solid #49494D; border-radius: 8px;
      padding: 32px 20px; text-align: center; text-decoration: none;
      transition: all 0.15s ease; cursor: pointer;
    }
    .image-placeholder:hover { background: #2C2D30; border-color: #1D9BD1; }
    .placeholder-content { display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .placeholder-icon { font-size: 40px; line-height: 1; opacity: 0.5; }
    .placeholder-text {
      font-size: 14px; color: #D1D2D3; font-weight: 600;
      word-break: break-all; max-width: 300px;
    }
    .placeholder-hint { font-size: 12px; color: #ABABAD; }
    .image-placeholder:hover .placeholder-hint { color: #1D9BD1; }

    .file-link { margin: 6px 0; }
    .file-link a {
      color: #D1D2D3; text-decoration: none; padding: 10px 14px;
      background: #222529; border: 1px solid #49494D; border-radius: 8px;
      display: inline-flex; align-items: center; gap: 10px;
      transition: all 0.1s ease; font-size: 14px;
    }
    .file-link a:hover { background: #2C2D30; border-color: #797C80; }

    .attachments { margin-top: 8px; }
    .attachment {
      padding: 12px 14px; background: #222529; border: 1px solid #49494D;
      border-radius: 8px; margin-bottom: 6px; border-left: 4px solid #49494D;
    }
    .attachment a { color: #1D9BD1; text-decoration: none; font-size: 15px; font-weight: 600; }
    .attachment a:hover { text-decoration: underline; }

    /* Reactions - Slack pill style */
    .reactions { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
    .reaction {
      padding: 2px 8px; background: #222529; border: 1px solid #49494D;
      border-radius: 24px; font-size: 12px; color: #D1D2D3;
      display: inline-flex; align-items: center; gap: 4px;
      transition: all 0.1s ease; cursor: pointer; line-height: 20px;
    }
    .reaction:hover { background: #2C2D30; border-color: #797C80; }

    /* Thread - Slack-style summary + expandable replies */
    .thread { margin-top: 6px; }
    .thread-summary {
      display: flex; align-items: center; gap: 8px; padding: 6px 0;
      cursor: pointer;
    }
    .thread-avatars { display: flex; }
    .thread-avatar {
      width: 24px; height: 24px; border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 11px; color: #FFFFFF;
      margin-right: -4px; border: 2px solid #1A1D21;
    }
    .thread-reply-count {
      font-size: 13px; color: #1D9BD1; font-weight: 700;
      margin-left: 4px;
    }
    .thread-reply-count:hover { text-decoration: underline; }
    .thread-last-reply { font-size: 12px; color: #ABABAD; }

    .thread-messages {
      margin-top: 4px; margin-left: 0; padding-left: 20px;
      border-left: 2px solid #49494D;
    }
    .thread-reply { display: flex; padding: 6px 0; gap: 8px; }
    .thread-reply .avatar { width: 28px; height: 28px; font-size: 12px; border-radius: 6px; flex-shrink: 0; }
    .thread-reply .message-content { flex: 1; min-width: 0; }
    .thread-reply .message-header { margin-bottom: 2px; }
    .thread-reply .author { font-size: 14px; }
    .thread-reply .timestamp { font-size: 11px; }
    .thread-reply .message-text { font-size: 14px; }

    .footer {
      margin-top: 48px; padding: 24px; border-top: 1px solid #49494D;
      text-align: center; color: #ABABAD; font-size: 13px;
    }
  `;
}

// --- Search Script (inline JS for self-contained export) ---

function getSearchScript() {
  return `
    let searchResults = [];
    let currentResultIndex = -1;

    const searchInput = document.getElementById('searchInput');
    const searchResultsSpan = document.getElementById('searchResults');
    const prevBtn = document.getElementById('prevResult');
    const nextBtn = document.getElementById('nextResult');
    const clearBtn = document.getElementById('clearSearch');

    searchInput.addEventListener('input', performSearch);
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.shiftKey ? navigateToPrev() : navigateToNext();
      }
      if (e.key === 'Escape') clearSearch();
    });

    prevBtn.addEventListener('click', navigateToPrev);
    nextBtn.addEventListener('click', navigateToNext);
    clearBtn.addEventListener('click', clearSearch);

    function performSearch() {
      const query = searchInput.value.trim().toLowerCase();
      clearHighlights();
      searchResults = [];
      currentResultIndex = -1;

      if (query.length < 2) { updateSearchUI(); return; }

      const messages = document.querySelectorAll('.message-text');
      messages.forEach((element) => {
        const text = element.innerHTML;
        const regex = new RegExp('(' + escapeRegex(query) + ')', 'gi');
        const tempRegex = new RegExp(escapeRegex(query), 'gi');
        let matchCount = 0;
        while (tempRegex.exec(element.textContent) !== null) matchCount++;

        if (matchCount > 0) {
          element.innerHTML = text.replace(regex, '<mark class="search-highlight">$1</mark>');
          element.querySelectorAll('.search-highlight').forEach(h => searchResults.push(h));
        }
      });

      if (searchResults.length > 0) {
        currentResultIndex = 0;
        scrollToResult(0);
      }
      updateSearchUI();
    }

    function clearHighlights() {
      document.querySelectorAll('.search-highlight, .search-highlight-active').forEach(mark => {
        const parent = mark.parentNode;
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      });
    }

    function escapeRegex(s) {
      return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    }

    function navigateToNext() {
      if (searchResults.length === 0) return;
      currentResultIndex = (currentResultIndex + 1) % searchResults.length;
      scrollToResult(currentResultIndex);
      updateSearchUI();
    }

    function navigateToPrev() {
      if (searchResults.length === 0) return;
      currentResultIndex = currentResultIndex <= 0 ? searchResults.length - 1 : currentResultIndex - 1;
      scrollToResult(currentResultIndex);
      updateSearchUI();
    }

    function scrollToResult(index) {
      document.querySelectorAll('.search-highlight-active').forEach(el => el.classList.remove('search-highlight-active'));
      const h = searchResults[index];
      if (h) {
        h.classList.add('search-highlight-active');
        h.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    function updateSearchUI() {
      if (searchResults.length === 0) {
        searchResultsSpan.textContent = searchInput.value.length >= 2 ? 'No results' : '0 results';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
      } else {
        searchResultsSpan.textContent = (currentResultIndex + 1) + '/' + searchResults.length;
        prevBtn.disabled = false;
        nextBtn.disabled = false;
      }
    }

    function clearSearch() {
      searchInput.value = '';
      clearHighlights();
      searchResults = [];
      currentResultIndex = -1;
      updateSearchUI();
    }
  `;
}

console.log('Slack Export background script loaded');
