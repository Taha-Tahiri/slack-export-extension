// Popup script - handles user interactions and displays progress

let isExtracting = false;

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('startBtn').addEventListener('click', startExtraction);
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
  const checkboxes = document.querySelectorAll('input[type="checkbox"]');

  if (isExtracting) {
    startBtn.style.display = 'none';
    stopBtn.style.display = 'flex';
    checkboxes.forEach(cb => cb.disabled = true);
  } else {
    startBtn.style.display = 'flex';
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
    }
  }
});
