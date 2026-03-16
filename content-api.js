// Content script for Slack conversation export
// Injected on https://*.slack.com/* pages
// Handles token extraction, Slack API calls, and data extraction

let isExtracting = false;
let abortController = null;

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startExtraction') {
    startExtraction(sendResponse);
    return true; // async response
  } else if (request.action === 'stopExtraction') {
    stopExtraction();
    sendResponse({ success: true });
  } else if (request.action === 'getStatus') {
    sendResponse({ isExtracting, extracting: isExtracting });
    return false;
  } else if (request.action === 'estimateExtraction') {
    estimateExtraction(request.options, sendResponse);
    return true; // async response
  }
});

// --- Extraction Entry Point ---

async function startExtraction(sendResponse) {
  if (isExtracting) {
    sendResponse({ success: false, error: 'Extraction already in progress' });
    return;
  }

  isExtracting = true;
  abortController = new AbortController();

  // Persist state so popup can restore on reopen
  await chrome.storage.local.set({
    extractionState: { isExtracting: true, progress: 'Initializing...', startedAt: Date.now() }
  });

  try {
    const credentials = await extractSlackCredentials();
    if (!credentials.token || !credentials.channel) {
      throw new Error('Could not extract Slack credentials. Make sure you are on a conversation page.');
    }

    const conversationType = detectConversationType();
    const conversationName = getConversationName();

    sendResponse({
      success: true,
      message: `Starting extraction of ${conversationType}: ${conversationName}`
    });

    // Fetch all messages with pagination
    const result = await fetchAllMessages(credentials);
    const messages = result.messages;
    const userMap = result.userMap;

    // Extract media URLs
    const media = extractMediaFiles(messages);

    // Notify about media count
    const mediaCount = media.length;
    const estimatedSeconds = Math.ceil(mediaCount * 0.5);
    let timeEstimate = '';
    if (mediaCount === 0) {
      timeEstimate = 'No media to download';
    } else if (estimatedSeconds < 60) {
      timeEstimate = `About ${estimatedSeconds} seconds`;
    } else {
      const mins = Math.floor(estimatedSeconds / 60);
      const secs = estimatedSeconds % 60;
      timeEstimate = `About ${mins}min ${secs}s`;
    }

    reportProgress(`${mediaCount} media file(s) found. ${timeEstimate}`);
    await sleep(1500);

    // Send data to background script for export
    chrome.runtime.sendMessage({
      action: 'exportData',
      data: {
        conversationType,
        conversationName,
        extractedAt: new Date().toISOString(),
        messageCount: messages.length,
        messages,
        media,
        mediaCount,
        userMap
      }
    });

  } catch (error) {
    if (error.name === 'AbortError') {
      reportProgress('Extraction cancelled.');
    } else {
      console.error('Extraction error:', error);
      chrome.runtime.sendMessage({
        action: 'extractionError',
        error: error.message
      });
    }
  } finally {
    isExtracting = false;
    abortController = null;
    await chrome.storage.local.remove('extractionState');
  }
}

function stopExtraction() {
  if (abortController) {
    abortController.abort();
  }
  isExtracting = false;
}

// --- Estimation ---

async function estimateExtraction(options, sendResponse) {
  try {
    sendResponse({ success: true, message: 'Estimating...' });

    const credentials = await extractSlackCredentials();
    if (!credentials.token || !credentials.channel) {
      throw new Error('Could not extract Slack credentials.');
    }

    const teamDomain = window.location.hostname.split('.')[0];
    const baseUrl = `https://${teamDomain}.slack.com/api/conversations.history`;

    const formData = new FormData();
    formData.append('token', credentials.token);
    formData.append('channel', credentials.channel);
    formData.append('limit', '200');

    const response = await fetch(baseUrl, {
      method: 'POST',
      body: formData,
      credentials: 'include'
    });

    const data = await response.json();
    if (!data.ok) throw new Error(`Slack API error: ${data.error || 'Unknown'}`);

    const firstPageCount = data.messages ? data.messages.length : 0;
    const hasMore = data.has_more || false;

    let mediaCount = 0;
    if (data.messages) {
      data.messages.forEach(msg => {
        if (msg.files && Array.isArray(msg.files)) {
          mediaCount += msg.files.length;
        }
      });
    }

    let estimatedMessages = firstPageCount;
    let estimatedMedia = mediaCount;

    if (hasMore && firstPageCount === 200) {
      estimatedMessages = firstPageCount * 5;
      estimatedMedia = mediaCount * 5;
    }

    let totalTimeSeconds = 0;
    const estimatedPages = Math.ceil(estimatedMessages / 200);
    totalTimeSeconds += estimatedPages * 1;
    totalTimeSeconds += 2; // user profiles

    const hasThreads = data.messages && data.messages.some(m => m.reply_count > 0);
    if (hasThreads) totalTimeSeconds += 5;

    if (options.exportJson) totalTimeSeconds += 1;
    if (options.exportHtml) totalTimeSeconds += 2;
    if (options.downloadMedia && estimatedMedia > 0) {
      totalTimeSeconds += estimatedMedia * 0.5;
    }

    const minutes = Math.floor(totalTimeSeconds / 60);
    const seconds = Math.ceil(totalTimeSeconds % 60);
    const timeDisplay = minutes > 0 ? `${minutes}min ${seconds}s` : `${seconds}s`;

    chrome.runtime.sendMessage({
      action: 'estimateComplete',
      data: {
        messageCount: estimatedMessages,
        mediaCount: estimatedMedia,
        estimatedTime: timeDisplay,
        isApproximate: hasMore
      }
    });

  } catch (error) {
    console.error('Estimation error:', error);
    chrome.runtime.sendMessage({
      action: 'estimateError',
      error: error.message
    });
  }
}

// --- Credential Extraction ---

async function extractSlackCredentials() {
  // Method 1: Try localStorage
  let apiToken = null;
  try {
    const localConfig = localStorage.getItem('localConfig_v2');
    if (localConfig) {
      const config = JSON.parse(localConfig);
      const teams = config?.teams;
      if (teams) {
        const teamId = Object.keys(teams)[0];
        apiToken = teams[teamId]?.token;
      }
    }
  } catch (e) {
    console.warn('Could not extract token from localStorage:', e);
  }

  // Method 2: Try cookies (d cookie)
  let dCookie = null;
  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === 'd') {
      dCookie = decodeURIComponent(value);
      break;
    }
  }

  // Method 3: Try window.TS.boot_data via page injection
  if (!apiToken) {
    apiToken = await extractTokenFromPage();
  }

  // Extract channel ID from URL
  let channelId = null;
  const urlMatch = window.location.pathname.match(/\/(C[A-Z0-9]+|D[A-Z0-9]+|G[A-Z0-9]+)/);
  if (urlMatch) {
    channelId = urlMatch[1];
  }

  // Fallback: try DOM attributes
  if (!channelId) {
    const channelEl = document.querySelector('[data-qa-channel-id]');
    if (channelEl) {
      channelId = channelEl.getAttribute('data-qa-channel-id');
    }
  }

  return {
    token: apiToken || dCookie,
    channel: channelId,
    team: window.location.pathname.match(/\/(T[A-Z0-9]+)/)?.[1]
  };
}

function extractTokenFromPage() {
  return new Promise((resolve) => {
    const handler = (event) => {
      if (event.data && event.data.type === 'SLACK_EXPORT_TOKEN') {
        window.removeEventListener('message', handler);
        resolve(event.data.token);
      }
    };
    window.addEventListener('message', handler);

    // Timeout after 2 seconds
    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, 2000);

    const script = document.createElement('script');
    script.textContent = `
      window.postMessage({
        type: 'SLACK_EXPORT_TOKEN',
        token: (window.TS && window.TS.boot_data && window.TS.boot_data.api_token) || null
      }, '*');
    `;
    document.head.appendChild(script);
    script.remove();
  });
}

// --- Message Fetching ---

async function fetchAllMessages(credentials) {
  const allMessages = [];
  const seenTimestamps = new Set();
  let hasMore = true;
  let cursor = null;
  let pageCount = 0;
  const maxPages = 1000;
  let consecutiveEmptyPages = 0;

  const teamDomain = window.location.hostname.split('.')[0];
  const baseUrl = `https://${teamDomain}.slack.com/api/conversations.history`;

  while (hasMore && pageCount < maxPages) {
    checkAborted();
    pageCount++;

    const formData = new FormData();
    formData.append('token', credentials.token);
    formData.append('channel', credentials.channel);
    formData.append('limit', '200');
    if (cursor) formData.append('cursor', cursor);

    reportProgress(`Fetching via API... (page ${pageCount}, ${allMessages.length} messages)`);

    const response = await fetch(baseUrl, {
      method: 'POST',
      body: formData,
      credentials: 'include',
      signal: abortController?.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error || 'Unknown error'}`);
    }

    if (data.messages && data.messages.length > 0) {
      let newCount = 0;
      for (const msg of data.messages) {
        if (!seenTimestamps.has(msg.ts)) {
          seenTimestamps.add(msg.ts);
          allMessages.push(msg);
          newCount++;
        }
      }

      if (newCount === 0) {
        consecutiveEmptyPages++;
        if (consecutiveEmptyPages >= 3) {
          hasMore = false;
          break;
        }
      } else {
        consecutiveEmptyPages = 0;
      }

      if (data.response_metadata?.next_cursor) {
        cursor = data.response_metadata.next_cursor;
        hasMore = true;
      } else {
        hasMore = data.has_more || false;
        cursor = null;
      }
    } else {
      consecutiveEmptyPages++;
      if (consecutiveEmptyPages >= 2) hasMore = false;
    }

    await sleep(150);
  }

  // Sort messages oldest-first (conversations.history returns newest-first)
  allMessages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

  console.log(`Fetched ${allMessages.length} messages from ${pageCount} pages`);

  // Fetch user profiles
  reportProgress('Fetching user profiles...');
  const userMap = await fetchUserProfiles(credentials, allMessages);

  // Fetch thread replies
  reportProgress('Fetching threads...');
  await fetchThreadReplies(credentials, allMessages, userMap);

  // Convert messages with real names
  const convertedMessages = allMessages.map(msg => convertSlackMessage(msg, userMap));

  return { messages: convertedMessages, userMap };
}

// --- User Profiles ---

async function fetchUserProfiles(credentials, messages) {
  const userMap = {};
  const userIds = new Set();

  messages.forEach(msg => {
    if (msg.user) userIds.add(msg.user);
    if (msg.bot_id) userIds.add(msg.bot_id);
    if (msg.text) {
      const mentions = msg.text.matchAll(/<@([UW][A-Z0-9]+)>/g);
      for (const match of mentions) userIds.add(match[1]);
    }
  });

  const teamDomain = window.location.hostname.split('.')[0];
  const baseUrl = `https://${teamDomain}.slack.com/api/users.info`;

  for (const userId of userIds) {
    checkAborted();
    try {
      const formData = new FormData();
      formData.append('token', credentials.token);
      formData.append('user', userId);

      const response = await fetch(baseUrl, {
        method: 'POST',
        body: formData,
        credentials: 'include',
        signal: abortController?.signal
      });

      if (response.ok) {
        const data = await response.json();
        if (data.ok && data.user) {
          userMap[userId] = {
            id: userId,
            name: data.user.name,
            real_name: data.user.real_name || data.user.profile?.real_name,
            display_name: data.user.profile?.display_name || data.user.real_name || data.user.name,
            email: data.user.profile?.email,
            is_bot: data.user.is_bot,
            profile: data.user.profile
          };
        } else {
          userMap[userId] = fallbackUser(userId);
        }
      } else {
        userMap[userId] = fallbackUser(userId);
      }

      await sleep(100);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      userMap[userId] = fallbackUser(userId);
    }
  }

  // Also fetch channel names for mentions
  await fetchChannelNames(credentials, messages, userMap);

  return userMap;
}

function fallbackUser(userId) {
  return { id: userId, name: userId, real_name: userId, display_name: userId };
}

async function fetchChannelNames(credentials, messages, userMap) {
  const channelIds = new Set();

  messages.forEach(msg => {
    if (msg.text) {
      const matches = msg.text.matchAll(/<#([CG][A-Z0-9]+)(?:\|([^>]+))?>/g);
      for (const match of matches) channelIds.add(match[1]);
    }
  });

  if (channelIds.size === 0) return;

  const teamDomain = window.location.hostname.split('.')[0];
  const baseUrl = `https://${teamDomain}.slack.com/api/conversations.info`;

  for (const channelId of channelIds) {
    checkAborted();
    try {
      const formData = new FormData();
      formData.append('token', credentials.token);
      formData.append('channel', channelId);

      const response = await fetch(baseUrl, {
        method: 'POST',
        body: formData,
        credentials: 'include',
        signal: abortController?.signal
      });

      if (response.ok) {
        const data = await response.json();
        if (data.ok && data.channel) {
          userMap[channelId] = {
            id: channelId,
            name: data.channel.name,
            display_name: `#${data.channel.name}`,
            is_channel: true
          };
        }
      }
      await sleep(100);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      console.warn(`Could not fetch channel info for ${channelId}:`, error);
    }
  }
}

// --- Thread Replies ---

async function fetchThreadReplies(credentials, messages, userMap) {
  const threadsToFetch = messages.filter(msg => msg.reply_count && msg.reply_count > 0);
  if (threadsToFetch.length === 0) return;

  const teamDomain = window.location.hostname.split('.')[0];
  const baseUrl = `https://${teamDomain}.slack.com/api/conversations.replies`;

  for (let i = 0; i < threadsToFetch.length; i++) {
    checkAborted();
    const threadMsg = threadsToFetch[i];

    try {
      const formData = new FormData();
      formData.append('token', credentials.token);
      formData.append('channel', credentials.channel);
      formData.append('ts', threadMsg.ts);
      formData.append('limit', '100');

      const response = await fetch(baseUrl, {
        method: 'POST',
        body: formData,
        credentials: 'include',
        signal: abortController?.signal
      });

      if (response.ok) {
        const data = await response.json();
        if (data.ok && data.messages && data.messages.length > 1) {
          const replies = data.messages.slice(1); // First is parent

          // Fetch profiles for new users in replies
          const newUserIds = new Set();
          replies.forEach(reply => {
            if (reply.user && !userMap[reply.user]) newUserIds.add(reply.user);
            if (reply.text) {
              const mentions = reply.text.matchAll(/<@([UW][A-Z0-9]+)>/g);
              for (const match of mentions) {
                if (!userMap[match[1]]) newUserIds.add(match[1]);
              }
            }
          });

          if (newUserIds.size > 0) {
            const userInfoUrl = `https://${teamDomain}.slack.com/api/users.info`;
            for (const userId of newUserIds) {
              try {
                const userFormData = new FormData();
                userFormData.append('token', credentials.token);
                userFormData.append('user', userId);

                const userResponse = await fetch(userInfoUrl, {
                  method: 'POST',
                  body: userFormData,
                  credentials: 'include',
                  signal: abortController?.signal
                });

                if (userResponse.ok) {
                  const userData = await userResponse.json();
                  if (userData.ok && userData.user) {
                    userMap[userId] = {
                      id: userId,
                      name: userData.user.name,
                      real_name: userData.user.real_name || userData.user.profile?.real_name,
                      display_name: userData.user.profile?.display_name || userData.user.real_name || userData.user.name,
                      email: userData.user.profile?.email,
                      is_bot: userData.user.is_bot,
                      profile: userData.user.profile
                    };
                  }
                }
                await sleep(50);
              } catch (error) {
                if (error.name === 'AbortError') throw error;
              }
            }
          }

          threadMsg.replies = replies;
        }
      }

      await sleep(200);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      console.error(`Error fetching thread ${threadMsg.ts}:`, error);
    }
  }
}

// --- Message Conversion ---

function convertSlackMessage(slackMsg, userMap) {
  const userId = slackMsg.user || slackMsg.bot_id;
  const userInfo = userMap[userId];
  const displayName = userInfo
    ? (userInfo.display_name || userInfo.real_name || userInfo.name)
    : (slackMsg.username || userId || 'Unknown');

  let processedText = replaceMentions(slackMsg.text || '', userMap);

  let convertedReplies = [];
  if (slackMsg.replies && Array.isArray(slackMsg.replies)) {
    convertedReplies = slackMsg.replies.map(reply => {
      const replyUserId = reply.user || reply.bot_id;
      const replyUserInfo = userMap[replyUserId];
      const replyDisplayName = replyUserInfo
        ? (replyUserInfo.display_name || replyUserInfo.real_name || replyUserInfo.name)
        : (reply.username || replyUserId || 'Unknown');

      return {
        type: reply.type || 'message',
        user: replyDisplayName,
        user_id: replyUserId,
        text: replaceMentions(reply.text || '', userMap),
        text_raw: reply.text,
        ts: reply.ts,
        timestamp: new Date(parseFloat(reply.ts) * 1000).toISOString(),
        reactions: reply.reactions,
        attachments: reply.attachments,
        files: reply.files
      };
    });
  }

  return {
    type: slackMsg.type || 'message',
    user: displayName,
    user_id: userId,
    user_real_name: userInfo?.real_name,
    user_email: userInfo?.email,
    text: processedText,
    text_raw: slackMsg.text,
    ts: slackMsg.ts,
    timestamp: new Date(parseFloat(slackMsg.ts) * 1000).toISOString(),
    thread_ts: slackMsg.thread_ts,
    reactions: slackMsg.reactions,
    attachments: slackMsg.attachments,
    files: slackMsg.files,
    reply_count: slackMsg.reply_count,
    reply_users_count: slackMsg.reply_users_count,
    latest_reply: slackMsg.latest_reply,
    replies: convertedReplies,
    subtype: slackMsg.subtype,
    bot_id: slackMsg.bot_id,
    app_id: slackMsg.app_id
  };
}

function replaceMentions(text, userMap) {
  if (!text) return text;

  // User mentions: <@U12345> or <@U12345|username>
  text = text.replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (match, userId, fallback) => {
    const info = userMap[userId];
    if (info && !info.is_channel) {
      return `@${info.display_name || info.real_name || info.name}`;
    }
    return fallback ? `@${fallback}` : match;
  });

  // Channel mentions: <#C12345|channel-name>
  text = text.replace(/<#([CG][A-Z0-9]+)(?:\|([^>]+))?>/g, (match, channelId, channelName) => {
    const info = userMap[channelId];
    if (info && info.is_channel) return info.display_name;
    return channelName ? `#${channelName}` : match;
  });

  // Special mentions
  text = text.replace(/<!here>/g, '@here');
  text = text.replace(/<!channel>/g, '@channel');
  text = text.replace(/<!everyone>/g, '@everyone');
  text = text.replace(/<!subteam\^([A-Z0-9]+)(?:\|([^>]+))?>/g, (match, id, name) => {
    return name ? `@${name}` : match;
  });

  return text;
}

// --- Media Extraction ---

function extractMediaFiles(messages) {
  const media = [];
  const seenUrls = new Set();
  const seenFileNames = new Map();

  for (const message of messages) {
    if (!message.files || !Array.isArray(message.files)) continue;

    message.files.forEach(file => {
      const fileUrl = file.url_private || file.url_private_download || file.permalink;
      if (!fileUrl || seenUrls.has(fileUrl)) return;
      seenUrls.add(fileUrl);

      let fileName = file.name || file.title || `file_${media.length}`;
      fileName = ensureCorrectExtension(fileName, file.mimetype, fileUrl);
      fileName = sanitizeFileName(fileName);

      // Handle duplicate filenames
      if (seenFileNames.has(fileName)) {
        const count = seenFileNames.get(fileName) + 1;
        seenFileNames.set(fileName, count);
        const lastDot = fileName.lastIndexOf('.');
        if (lastDot > 0) {
          fileName = `${fileName.substring(0, lastDot)}_${count}${fileName.substring(lastDot)}`;
        } else {
          fileName = `${fileName}_${count}`;
        }
      } else {
        seenFileNames.set(fileName, 1);
      }

      media.push({
        type: file.mimetype?.startsWith('image/') ? 'image' : 'file',
        url: fileUrl,
        name: fileName,
        originalName: file.name || file.title,
        mimetype: file.mimetype,
        timestamp: message.timestamp
      });
    });
  }

  return media;
}

function ensureCorrectExtension(fileName, mimeType, fileUrl) {
  const mimeToExt = {
    'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
    'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
    'image/bmp': '.bmp', 'application/pdf': '.pdf', 'text/plain': '.txt',
    'text/html': '.html', 'text/css': '.css', 'text/javascript': '.js',
    'application/json': '.json', 'application/xml': '.xml',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
    'application/zip': '.zip', 'application/x-rar-compressed': '.rar',
    'application/x-7z-compressed': '.7z'
  };

  const currentExt = fileName.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  const baseName = currentExt ? fileName.substring(0, fileName.lastIndexOf('.')) : fileName;

  // Priority 1: MIME type
  if (mimeType && mimeToExt[mimeType]) {
    const correctExt = mimeToExt[mimeType];
    if (currentExt !== correctExt) return baseName + correctExt;
    return fileName;
  }

  // Priority 2: URL extension
  if (fileUrl) {
    try {
      const urlPath = new URL(fileUrl).pathname;
      const urlExt = urlPath.match(/\.[^.]+$/)?.[0]?.toLowerCase()?.split('?')[0];
      if (urlExt && /^\.(jpg|jpeg|png|gif|webp|svg|pdf|txt|html|json|mp4|mov|webm|mp3|wav|zip|rar)$/i.test(urlExt)) {
        if (!currentExt) return fileName + urlExt;
        if (currentExt !== urlExt) return baseName + urlExt;
      }
    } catch (e) { /* ignore invalid URL */ }
  }

  return fileName;
}

function sanitizeFileName(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 100);
}

// --- Utility Functions ---

function detectConversationType() {
  const url = window.location.href;
  if (url.includes('/messages/') || url.match(/\/D[A-Z0-9]+/)) return 'direct_message';
  if (url.includes('/archives/') || url.match(/\/C[A-Z0-9]+/)) return 'channel';
  if (url.match(/\/G[A-Z0-9]+/)) return 'group';
  return 'unknown';
}

function getConversationName() {
  const selectors = [
    '[data-qa="channel_name"]',
    '[data-qa="conversation_name"]',
    '.p-view_header__channel_title',
    '.p-ia__view_header__channel_name'
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el.textContent.trim();
  }

  const match = window.location.pathname.match(/\/([^/]+)$/);
  return match ? match[1] : 'unknown';
}

function reportProgress(message) {
  chrome.runtime.sendMessage({ action: 'progress', message });
  // Persist progress so popup can restore on reopen
  chrome.storage.local.set({
    extractionState: { isExtracting: true, progress: message, startedAt: Date.now() }
  });
}

function checkAborted() {
  if (abortController?.signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('Slack Export content script loaded');
