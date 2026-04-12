'use strict';

const SERVER_URL = 'https://whatsapp.imaccelerator.com';

const stepLogin = document.getElementById('step-login');
const stepRep = document.getElementById('step-rep');
const stepDone = document.getElementById('step-done');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('login-btn');
const repSelect = document.getElementById('rep-select');
const saveRepBtn = document.getElementById('save-rep-btn');
const repNameDisplay = document.getElementById('rep-name-display');
const repStatusDisplay = document.getElementById('rep-status-display');
const changeBtn = document.getElementById('change-btn');
const logoutBtn = document.getElementById('logout-btn');
const statusEl = document.getElementById('status');

function showStep(step) {
  stepLogin.classList.remove('active');
  stepRep.classList.remove('active');
  stepDone.classList.remove('active');
  step.classList.add('active');
  statusEl.className = 'status';
}

function showStatus(msg, ok) {
  statusEl.className = 'status ' + (ok ? 'ok' : 'err');
  statusEl.textContent = msg;
}

// Check if already configured
chrome.storage.sync.get(['token', 'repId', 'repName', 'repStatus'], (data) => {
  if (data.token && data.repId) {
    repNameDisplay.textContent = data.repName || data.repId;
    repStatusDisplay.textContent = data.repStatus || 'unknown';
    showStep(stepDone);
    // Refresh status
    refreshRepStatus(data.token, data.repId);
  } else if (data.token) {
    loadReps(data.token);
    showStep(stepRep);
  }
});

// Step 1: Login
loginBtn.addEventListener('click', async () => {
  const token = passwordInput.value.trim();
  if (!token) { showStatus('Password is required', false); return; }

  loginBtn.textContent = 'Connecting...';
  try {
    const res = await fetch(SERVER_URL + '/api/reps', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) {
      showStatus('Invalid password', false);
      loginBtn.textContent = 'Connect';
      return;
    }
    chrome.storage.sync.set({ token, serverUrl: SERVER_URL });
    await loadReps(token);
    showStep(stepRep);
  } catch (err) {
    showStatus('Cannot connect to server', false);
  }
  loginBtn.textContent = 'Connect';
});

passwordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loginBtn.click();
});

// Step 2: Select rep
async function loadReps(token) {
  try {
    const res = await fetch(SERVER_URL + '/api/reps', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    const reps = await res.json();
    if (!reps.length) {
      repSelect.innerHTML = '<option value="">No reps found</option>';
      return;
    }
    repSelect.innerHTML = reps.map(r =>
      `<option value="${r.id}" data-name="${r.name}" data-status="${r.status}">${r.name} (${r.status})</option>`
    ).join('');
  } catch (err) {
    repSelect.innerHTML = '<option value="">Error loading reps</option>';
  }
}

saveRepBtn.addEventListener('click', () => {
  const selected = repSelect.options[repSelect.selectedIndex];
  if (!selected || !selected.value) { showStatus('Select a rep', false); return; }

  const repId = selected.value;
  const repName = selected.dataset.name;
  const repStatus = selected.dataset.status;

  chrome.storage.sync.set({ repId, repName, repStatus }, () => {
    repNameDisplay.textContent = repName;
    repStatusDisplay.textContent = repStatus;
    showStep(stepDone);
    showStatus('Saved', true);
  });
});

// Step 3: Connected
changeBtn.addEventListener('click', () => {
  chrome.storage.sync.get(['token'], (data) => {
    if (data.token) {
      loadReps(data.token);
      showStep(stepRep);
    }
  });
});

logoutBtn.addEventListener('click', () => {
  chrome.storage.sync.clear(() => {
    passwordInput.value = '';
    showStep(stepLogin);
  });
});

async function refreshRepStatus(token, repId) {
  try {
    const res = await fetch(SERVER_URL + '/api/reps', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    const reps = await res.json();
    const rep = reps.find(r => r.id === repId);
    if (rep) {
      repNameDisplay.textContent = rep.name;
      repStatusDisplay.textContent = rep.status;
      chrome.storage.sync.set({ repName: rep.name, repStatus: rep.status });
    }
  } catch (err) { /* silent */ }
}
