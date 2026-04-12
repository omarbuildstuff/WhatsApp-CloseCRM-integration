'use strict';

(function () {
  if (document.getElementById('waclose-widget')) return;

  const SERVER_URL = 'https://whatsapp.imaccelerator.com';

  // ── Inject Widget HTML ──────────────────────────────────────────────────────

  const widget = document.createElement('div');
  widget.id = 'waclose-widget';
  widget.innerHTML = `
    <div id="waclose-panel">
      <div class="waclose-header">
        WA<span>/</span>Close
        <button class="waclose-close" id="waclose-close-btn">&times;</button>
      </div>
      <div class="waclose-body">
        <div id="waclose-not-configured" style="display:none">
          <p style="font-size:12px;color:#6B6B6B;text-align:center;padding:12px 0">
            Click the extension icon to log in and select your rep.
          </p>
        </div>
        <div id="waclose-form" style="display:none">
          <div id="waclose-rep-info" style="font-size:11px;color:#6B6B6B;margin-bottom:12px">
            Sending as <strong id="waclose-rep-name" style="color:#0F0F0F"></strong>
          </div>
          <div class="waclose-field">
            <label>Phone</label>
            <input type="text" id="waclose-phone" placeholder="+15551234567" />
          </div>
          <div id="waclose-detected" class="waclose-detected" style="display:none"></div>
          <div class="waclose-field" style="margin-top:14px">
            <label>Message</label>
            <textarea id="waclose-message" placeholder="Type your message..."></textarea>
          </div>
          <button class="waclose-send" id="waclose-send-btn" style="margin-top:14px">Send WhatsApp</button>
          <div class="waclose-status" id="waclose-status"></div>
        </div>
      </div>
    </div>
    <button id="waclose-fab">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
      </svg>
    </button>
  `;
  document.body.appendChild(widget);

  // ── State ───────────────────────────────────────────────────────────────────

  let token = '';
  let repId = '';

  // ── Elements ────────────────────────────────────────────────────────────────

  const fab = document.getElementById('waclose-fab');
  const panel = document.getElementById('waclose-panel');
  const closeBtn = document.getElementById('waclose-close-btn');
  const notConfigured = document.getElementById('waclose-not-configured');
  const form = document.getElementById('waclose-form');
  const repNameEl = document.getElementById('waclose-rep-name');
  const phoneInput = document.getElementById('waclose-phone');
  const messageInput = document.getElementById('waclose-message');
  const sendBtn = document.getElementById('waclose-send-btn');
  const statusEl = document.getElementById('waclose-status');
  const detectedEl = document.getElementById('waclose-detected');

  // ── Toggle Panel ────────────────────────────────────────────────────────────

  fab.addEventListener('click', () => {
    const isOpen = panel.classList.contains('open');
    if (isOpen) {
      panel.classList.remove('open');
    } else {
      panel.classList.add('open');
      loadSettings();
      detectPhoneFromPage();
    }
  });

  closeBtn.addEventListener('click', () => {
    panel.classList.remove('open');
  });

  // ── Load Settings ───────────────────────────────────────────────────────────

  function loadSettings() {
    chrome.storage.sync.get(['token', 'repId', 'repName'], (data) => {
      if (!data.token || !data.repId) {
        notConfigured.style.display = 'block';
        form.style.display = 'none';
        return;
      }
      token = data.token;
      repId = data.repId;
      repNameEl.textContent = data.repName || 'Unknown';
      notConfigured.style.display = 'none';
      form.style.display = 'block';
    });
  }

  // ── Detect Phone from Close Lead Page ───────────────────────────────────────

  function detectPhoneFromPage() {
    const phoneRegex = /\+?\d[\d\s\-().]{7,}\d/g;
    const candidates = [];

    const selectors = [
      '[data-test-id="contact-phone"]',
      '.contact-phone',
      'a[href^="tel:"]',
      '[class*="phone"]',
      '[class*="Phone"]',
    ];

    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        const text = el.textContent || el.getAttribute('href') || '';
        const matches = text.match(phoneRegex);
        if (matches) candidates.push(...matches);
      });
    }

    if (candidates.length === 0) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent || '';
        const matches = text.match(phoneRegex);
        if (matches) {
          for (const m of matches) {
            const digits = m.replace(/\D/g, '');
            if (digits.length >= 10 && digits.length <= 15) {
              candidates.push(m.trim());
            }
          }
        }
      }
    }

    const unique = [...new Set(candidates.map(c => c.replace(/[\s\-().]/g, '')))];

    if (unique.length > 0) {
      const phone = unique[0].startsWith('+') ? unique[0] : '+' + unique[0];
      phoneInput.value = phone;
      detectedEl.innerHTML = `Auto-detected <strong>${phone}</strong> from this lead`;
      detectedEl.style.display = 'block';
    } else {
      detectedEl.style.display = 'none';
    }
  }

  // ── Send Message ────────────────────────────────────────────────────────────

  sendBtn.addEventListener('click', async () => {
    const phone = phoneInput.value.trim();
    const message = messageInput.value.trim();

    if (!phone || !message) {
      showStatus('Phone and message are required', false);
      return;
    }

    if (!repId || !token) {
      showStatus('Not configured — click extension icon', false);
      return;
    }

    sendBtn.classList.add('loading');
    sendBtn.textContent = 'Sending...';

    try {
      const res = await fetch(SERVER_URL + '/api/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify({ repId, phone, message }),
      });

      const body = await res.json().catch(() => ({}));

      if (res.ok) {
        showStatus('Message sent!', true);
        messageInput.value = '';
      } else {
        showStatus(body.error || 'Failed to send', false);
      }
    } catch (err) {
      showStatus('Network error', false);
    } finally {
      sendBtn.classList.remove('loading');
      sendBtn.textContent = 'Send WhatsApp';
    }
  });

  // ── Keyboard shortcut ───────────────────────────────────────────────────────

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function showStatus(msg, ok) {
    statusEl.className = 'waclose-status ' + (ok ? 'ok' : 'err');
    statusEl.textContent = msg;
    setTimeout(() => { statusEl.className = 'waclose-status'; }, 4000);
  }

  // ── Watch for URL changes (Close is an SPA) ─────────────────────────────────

  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (panel.classList.contains('open')) {
        detectPhoneFromPage();
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
