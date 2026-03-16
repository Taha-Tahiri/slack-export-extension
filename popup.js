// Popup script - handles user interactions and displays progress

let isExtracting = false;

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('startBtn').addEventListener('click', startExtraction);
  document.getElementById('estimateBtn').addEventListener('click', estimateExtraction);
  document.getElementById('stopBtn').addEventListener('click', stopExtraction);

  checkSlackPage();
  restoreState();
});

// Restore extraction state if popup was closed and reopened mid-extraction
async function restoreState() {
  const { extractionState } = await chrome.storage.local.get('extractionState');
  if (extractionState && extractionState.isExtracting) {
    isExtracting = true;
    updateUI();
    showProgress(extractionState.progress || 'Export in progress...');
    showStatus('info', 'Export is running...');
  }
}

async function checkSlackPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url || !tab.url.includes('slack.com')) {
    showStatus('warning', 'Please open this extension on a Slack page');
    document.getElementById('startBtn').disabled = true;
    document.getElementById('estimateBtn').disabled = true;
  }
}

async function startExtraction() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url || !tab.url.includes('slack.com')) {
    showStatus('error', 'This extension only works on Slack');
    return;
  }

  isExtracting = true;
  updateUI();

  const options = getExportOptions();
  await chrome.storage.local.set({ exportOptions: options });

  showStatus('info', 'Extraction started...');
  showProgress('Initializing...');

  chrome.tabs.sendMessage(tab.id, { action: 'startExtraction' }, (response) => {
    if (chrome.runtime.lastError) {
      showStatus('error', 'Error: ' + chrome.runtime.lastError.message);
      isExtracting = false;
      updateUI();
      return;
    }
    if (response && response.success) {
      showStatus('info', response.message);
    } else if (response && response.error) {
      showStatus('error', response.error);
      isExtracting = false;
      updateUI();
    }
  });
}

async function estimateExtraction() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url || !tab.url.includes('slack.com')) {
    showStatus('error', 'This extension only works on Slack');
    return;
  }

  const options = getExportOptions();
  document.getElementById('estimate').style.display = 'none';
  showStatus('info', 'Analyzing conversation...');
  document.getElementById('estimateBtn').disabled = true;

  chrome.tabs.sendMessage(tab.id, {
    action: 'estimateExtraction',
    options
  }, (response) => {
    if (chrome.runtime.lastError) {
      showStatus('error', 'Error: ' + chrome.runtime.lastError.message);
      document.getElementById('estimateBtn').disabled = false;
      return;
    }
    if (response && response.success) {
      showStatus('info', response.message);
    }
  });
}

async function stopExtraction() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: 'stopExtraction' });

  isExtracting = false;
  updateUI();
  showStatus('warning', 'Extraction stopped');
  hideProgress();
  await chrome.storage.local.remove('extractionState');
}

function getExportOptions() {
  return {
    exportJson: document.getElementById('exportJson').checked,
    exportHtml: document.getElementById('exportHtml').checked,
    downloadMedia: document.getElementById('downloadMedia').checked
  };
}

function updateUI() {
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const estimateBtn = document.getElementById('estimateBtn');
  const checkboxes = document.querySelectorAll('input[type="checkbox"]');

  if (isExtracting) {
    startBtn.style.display = 'none';
    estimateBtn.style.display = 'none';
    stopBtn.style.display = 'flex';
    checkboxes.forEach(cb => cb.disabled = true);
  } else {
    startBtn.style.display = 'flex';
    estimateBtn.style.display = 'flex';
    stopBtn.style.display = 'none';
    checkboxes.forEach(cb => cb.disabled = false);
  }
}

function showStatus(type, message) {
  const el = document.getElementById('status');
  el.className = `status ${type}`;
  el.textContent = message;
  el.style.display = 'block';
}

function showProgress(message) {
  const el = document.getElementById('progress');
  document.getElementById('progressText').textContent = message;
  el.style.display = 'block';
}

function hideProgress() {
  document.getElementById('progress').style.display = 'none';
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'progress') {
    showProgress(message.message);
  } else if (message.action === 'exportComplete') {
    isExtracting = false;
    updateUI();
    hideProgress();
    showStatus('success', `Export complete! ${message.messageCount} messages exported`);
    document.getElementById('messageCount').textContent = `${message.messageCount} messages`;
  } else if (message.action === 'exportError') {
    isExtracting = false;
    updateUI();
    hideProgress();
    showStatus('error', 'Error: ' + message.error);
  } else if (message.action === 'updateCount') {
    document.getElementById('messageCount').textContent = `${message.count} messages`;
  } else if (message.action === 'estimateComplete') {
    document.getElementById('estimateBtn').disabled = false;
    document.getElementById('status').style.display = 'none';

    const data = message.data;
    const approx = data.isApproximate ? ' (approx.)' : '';
    const downloadMedia = document.getElementById('downloadMedia').checked;
    const exportJson = document.getElementById('exportJson').checked;
    const exportHtml = document.getElementById('exportHtml').checked;

    let mediaLine = '';
    if (data.mediaCount > 0) {
      if (downloadMedia) {
        mediaLine = `<div style="margin-bottom: 4px; color: #86efac;"><strong>${data.mediaCount}${approx}</strong> media file(s) included</div>`;
      } else {
        mediaLine = `<div style="margin-bottom: 4px; color: #6b7280;"><strong>${data.mediaCount}${approx}</strong> media file(s) skipped</div>`;
      }
    }

    const formats = [];
    if (exportJson) formats.push('JSON');
    if (exportHtml) formats.push('HTML');

    const estimateEl = document.getElementById('estimate');
    document.getElementById('estimateDetails').innerHTML = `
      <div style="margin-bottom: 4px;"><strong>${data.messageCount}${approx}</strong> messages</div>
      ${mediaLine}
      <div style="margin-bottom: 4px;">Format: <strong>${formats.join(' + ') || 'None'}</strong></div>
      <div>Estimated time: <strong>${data.estimatedTime}</strong></div>
    `;
    estimateEl.style.display = 'block';
  } else if (message.action === 'estimateError') {
    document.getElementById('estimateBtn').disabled = false;
    showStatus('error', 'Estimation error: ' + message.error);
  }
});

// Listen for storage changes to update progress in real-time even after reopen
chrome.storage.onChanged.addListener((changes) => {
  if (changes.extractionState) {
    const state = changes.extractionState.newValue;
    if (state && state.isExtracting) {
      if (!isExtracting) {
        isExtracting = true;
        updateUI();
      }
      showProgress(state.progress || 'Export in progress...');
    } else if (!state) {
      // Extraction finished (state was removed)
      // The exportComplete/exportError message handles UI update
    }
  }
});
