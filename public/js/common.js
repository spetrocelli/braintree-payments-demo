// Shared helpers across the demo pages.

export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || data.detail || `Error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export function getConfig() {
  return api('/api/config');
}

// Requests a client token (optionally linked to an existing customer).
export async function getClientToken(email) {
  const qs = email ? `?email=${encodeURIComponent(email)}` : '';
  const data = await api(`/api/client-token${qs}`);
  return data; // { clientToken, customerId }
}

export function showResult(el, ok, title, payload) {
  el.className = `result show ${ok ? 'success' : 'error'}`;
  let html = `<strong>${title}</strong>`;
  if (payload) html += `<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
  el.innerHTML = html;
}

export function liabilityBadge(threeDS) {
  if (!threeDS) return '<span class="badge amber">3DS not applied</span>';
  if (threeDS.liabilityShifted) return '<span class="badge green">Liability shift ✓ (3DS ' + (threeDS.version || '') + ')</span>';
  if (threeDS.liabilityShiftPossible) return '<span class="badge amber">3DS attempted, shift did not occur</span>';
  return '<span class="badge red">No liability shift</span>';
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function setLoading(btn, loading, label) {
  if (loading) {
    // Save the original label only on the FIRST entry into the loading state,
    // so that repeated calls (Tokenization → 3DS → Charge) do not overwrite it
    // with the spinner HTML.
    if (btn.dataset.loading !== 'true') {
      btn.dataset.label = btn.innerHTML;
      btn.dataset.loading = 'true';
    }
    btn.innerHTML = `<span class="spinner"></span> ${label || 'Processing...'}`;
    btn.disabled = true;
  } else {
    btn.dataset.loading = 'false';
    btn.innerHTML = label || btn.dataset.label || 'Pay';
    btn.disabled = false;
  }
}

// ---- Flow log: live panel that shows the payment iterations ----
const FLOW_CAT = {
  user: { label: '👤 USER', cls: 'user' },
  sdk: { label: '🟪 CLIENT SDK', cls: 'sdk' },
  http: { label: '🟦 → BACKEND', cls: 'http' },
  server: { label: '🟩 ← BACKEND', cls: 'server' },
  error: { label: '🔴 ERROR', cls: 'error' },
};

export function createFlowLog(containerId) {
  const el = document.getElementById(containerId);

  function add(cat, msg, data) {
    const meta = FLOW_CAT[cat] || { label: cat, cls: 'sdk' };
    const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const row = document.createElement('div');
    row.className = `log-row log-${meta.cls}`;
    row.innerHTML =
      `<span class="log-time">${t}</span>` +
      `<span class="log-cat">${meta.label}</span>` +
      `<span class="log-msg">${escapeHtml(msg)}</span>`;
    if (data !== undefined && data !== null) {
      const pre = document.createElement('pre');
      pre.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      row.appendChild(pre);
    }
    if (el) {
      el.appendChild(row);
      el.scrollTop = el.scrollHeight;
    }
    // Also in the browser console, for those who prefer the DevTools.
    console.log(`%c[${meta.label}]%c ${msg}`, 'font-weight:bold', '', data ?? '');
  }

  return {
    user: (m, d) => add('user', m, d),
    sdk: (m, d) => add('sdk', m, d),
    http: (m, d) => add('http', m, d),
    server: (m, d) => add('server', m, d),
    error: (m, d) => add('error', m, d),
    clear: () => { if (el) el.innerHTML = ''; },
  };
}

// Truncates a nonce for the logs (single-use token, we avoid printing it in full).
export function maskNonce(n) {
  return typeof n === 'string' && n.length > 12 ? `${n.slice(0, 12)}…` : n;
}

// Generates a unique merchant orderId (e.g. DEMO-LXYZ-AB12C).
export function genOrderId() {
  return `DEMO-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

// Binds an "Order ID (merchant)" box to an element and handles regeneration.
// Returns { value, regenerate } — value is always the current orderId.
export function createOrderId(displayElId, regenBtnId) {
  const display = document.getElementById(displayElId);
  const ctx = { value: '' };

  function render() {
    if (display) display.textContent = ctx.value;
  }
  ctx.regenerate = () => {
    ctx.value = genOrderId();
    render();
    return ctx.value;
  };

  ctx.regenerate(); // first value
  const btn = regenBtnId && document.getElementById(regenBtnId);
  if (btn) btn.addEventListener('click', () => ctx.regenerate());
  return ctx;
}

// Navigates the menu items highlighting the active page.
export function highlightNav() {
  const page = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('header.topbar nav a').forEach((a) => {
    if (a.getAttribute('href') === page) a.classList.add('active');
  });
}
