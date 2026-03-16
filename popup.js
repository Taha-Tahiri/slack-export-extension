// Popup script - handles user interactions and displays progress

let isExtracting = false;

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('startBtn').addEventListener('click', startExtraction);
  document.getElementById('stopBtn').addEventListener('click', stopExtraction);

  setupDateRangeControls();
  checkSlackPage();
  restoreState();
});

function setupDateRangeControls() {
  const rangeAll = document.getElementById('rangeAll');
  const rangeCustom = document.getElementById('rangeCustom');
  const dateInputs = document.getElementById('dateInputs');

  const toggle = () => {
    dateInputs.style.display = rangeCustom.checked ? 'flex' : 'none';
  };

  rangeAll.addEventListener('change', toggle);
  rangeCustom.addEventListener('change', toggle);

  // Set default "To" date to today
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('dateTo').value = today;
}

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

  const options = getExportOptions();

  if (options.dateRange === 'custom') {
    const fromVal = document.getElementById('dateFrom').value;
    const toVal = document.getElementById('dateTo').value;
    if (!fromVal && !toVal) {
      showStatus('error', 'Please select at least one date for the custom range');
      return;
    }
    if (fromVal && toVal && new Date(fromVal) > new Date(toVal)) {
      showStatus('error', '"From" date must be before "To" date');
      return;
    }
  }

  isExtracting = true;
  updateUI();

  await chrome.storage.local.set({ exportOptions: options });

  showStatus('info', 'Extraction started...');
  showProgress('Initializing...');

  chrome.tabs.sendMessage(tab.id, { action: 'startExtraction', options }, (response) => {
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
  const isCustomRange = document.getElementById('rangeCustom').checked;
  const options = {
    exportJson: document.getElementById('exportJson').checked,
    exportHtml: document.getElementById('exportHtml').checked,
    downloadMedia: document.getElementById('downloadMedia').checked,
    dateRange: 'all'
  };

  if (isCustomRange) {
    const fromVal = document.getElementById('dateFrom').value;
    const toVal = document.getElementById('dateTo').value;
    options.dateRange = 'custom';
    // Convert date strings to Unix timestamps (seconds) for the Slack API
    if (fromVal) {
      options.oldest = new Date(fromVal).getTime() / 1000;
    }
    if (toVal) {
      // End of the selected day (23:59:59.999)
      const toDate = new Date(toVal);
      toDate.setHours(23, 59, 59, 999);
      options.latest = toDate.getTime() / 1000;
    }
  }

  return options;
}

function updateUI() {
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const allInputs = document.querySelectorAll('input[type="checkbox"], input[type="radio"], input[type="date"]');

  if (isExtracting) {
    startBtn.style.display = 'none';
    stopBtn.style.display = 'flex';
    allInputs.forEach(el => el.disabled = true);
  } else {
    startBtn.style.display = 'flex';
    stopBtn.style.display = 'none';
    allInputs.forEach(el => el.disabled = false);
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
