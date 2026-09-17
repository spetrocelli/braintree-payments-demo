import { getConfig, getClientToken, showResult, liabilityBadge, setLoading, highlightNav, api, escapeHtml, createFlowLog, maskNonce, createOrderId } from '/js/common.js';

highlightNav();
const flow = createFlowLog('flow-log');
document.getElementById('clear-log').addEventListener('click', () => flow.clear());

// Merchant Order ID: unique per transaction, displayed and regeneratable.
const orderId = createOrderId('order-id', 'regen-order');

const state = {
  scenario: 'guest', // guest | vault | returning | mit
  lookupType: 'email', // email | customerId (returning / mit only)
  config: null,
  clientInstance: null,
  hostedFields: null,
  threeDS: null,
  dataCollector: null,
  vaultManager: null,
  selectedNonce: null, // for the "buyer present" flows (returning)
  selectedToken: null, // for the "buyer not present" flow (mit, server-side)
  selectedMethod: null,
};

const els = {
  envBadge: document.getElementById('env-badge'),
  pills: document.getElementById('pills'),
  scnDesc: document.getElementById('scn-desc'),
  emailBlock: document.getElementById('email-block'),
  email: document.getElementById('email'),
  emailLabel: document.getElementById('email-label'),
  lookupToggle: document.getElementById('lookup-toggle'),
  newCardBlock: document.getElementById('new-card-block'),
  returningBlock: document.getElementById('returning-block'),
  mitOptions: document.getElementById('mit-options'),
  txnSource: document.getElementById('txn-source'),
  payCardBtn: document.getElementById('pay-card-btn'),
  loadVaultBtn: document.getElementById('load-vault-btn'),
  vaultedList: document.getElementById('vaulted-list'),
  payVaultedBtn: document.getElementById('pay-vaulted-btn'),
  result: document.getElementById('result'),
};

const DESCRIPTIONS = {
  guest: 'One-time payment without saving the card. 3DS applied; no customer created in the Vault.',
  vault: 'The card is saved in the Braintree Vault (associated with the customer via email) and charged at the same time.',
  returning:
    'Buyer present (CIT): the customer is present and uses a card already in the Vault. We read the methods via vaultManager (client SDK), apply 3DS and collect the payment.',
  mit:
    'Buyer not present (MIT): SERVER-SIDE charge on a card already in the Vault, without interaction or 3DS — e.g. utility bill, installment, subscription. Uses the payment method token and transactionSource. No client SDK involved.',
};

// ---- Bootstrap ----
(async function init() {
  state.config = await getConfig();
  els.envBadge.textContent = state.config.environment;
  setScenario('guest');
  await rebuildClient(); // initial "guest" client
})();

// ---- Scenario handling ----
els.pills.addEventListener('click', (e) => {
  const pill = e.target.closest('.pill');
  if (!pill) return;
  document.querySelectorAll('.pill').forEach((p) => p.classList.remove('active'));
  pill.classList.add('active');
  setScenario(pill.dataset.scn);
});

function setScenario(scn) {
  state.scenario = scn;
  els.scnDesc.textContent = DESCRIPTIONS[scn];
  els.result.className = 'result';

  const usesVault = scn === 'returning' || scn === 'mit';

  // block visibility
  els.newCardBlock.classList.toggle('hidden', usesVault);
  els.returningBlock.classList.toggle('hidden', !usesVault);
  els.mitOptions.classList.toggle('hidden', scn !== 'mit');
  els.lookupToggle.classList.toggle('hidden', !usesVault);

  // outside returning/mit, always look up by email
  if (!usesVault) {
    state.lookupType = 'email';
    els.lookupToggle.querySelectorAll('input[name="lookup-type"]').forEach((r) => (r.checked = r.value === 'email'));
  }
  updateIdentifierField();

  // contextual labels
  els.loadVaultBtn.textContent =
    scn === 'mit' ? 'Load saved cards (server-side)' : 'Load saved methods';

  // reset vault selection
  els.vaultedList.innerHTML = '';
  els.payVaultedBtn.classList.add('hidden');
  state.selectedNonce = null;
  state.selectedToken = null;
  state.selectedMethod = null;
}

// Switches the shared input between "email" and "customerId" lookup mode.
function updateIdentifierField() {
  const isCustomerId = state.lookupType === 'customerId';
  els.email.type = isCustomerId ? 'text' : 'email';
  els.emailLabel.textContent = isCustomerId ? 'Customer ID' : 'Customer email';
  els.email.placeholder = isCustomerId
    ? 'e.g. 158712636'
    : state.scenario === 'guest'
      ? 'mario.rossi@example.com (optional)'
      : 'mario.rossi@example.com';
}

els.lookupToggle.addEventListener('change', (e) => {
  if (e.target.name !== 'lookup-type') return;
  state.lookupType = e.target.value;
  els.email.value = '';
  updateIdentifierField();
});

// Reads the current identifier from the shared input, based on the active lookup mode.
function getIdentifier() {
  const value = els.email.value.trim();
  if (!value) return null;
  return state.lookupType === 'customerId' ? { customerId: value } : { email: value };
}

function identifierLabel(identifier) {
  return identifier.customerId ? `customerId: ${identifier.customerId}` : identifier.email;
}

// Recreates the SDK client + Hosted Fields (needed to attach the customer in returning).
// `identifier` is optional: { email } or { customerId }.
async function rebuildClient(identifier) {
  setLoading(els.payCardBtn, true, 'Initializing…');
  try {
    flow.http(`Requesting client token${identifier ? ` (customer: ${identifierLabel(identifier)})` : ' (anonymous)'}`);
    const { clientToken, customerId } = await getClientToken(identifier);
    flow.server(`Client token received`, { linkedCustomer: customerId || null });

    state.clientInstance = await braintree.client.create({ authorization: clientToken });
    flow.sdk('braintree.client created');

    // Data Collector (anti-fraud device data) — best practice.
    state.dataCollector = await braintree.dataCollector.create({ client: state.clientInstance });
    flow.sdk('dataCollector created (anti-fraud device data)');

    // 3D Secure 2.
    state.threeDS = await braintree.threeDSecure.create({ version: 2, client: state.clientInstance });
    flow.sdk('threeDSecure (v2) ready');

    // Hosted Fields (only for the new-card flows).
    if (state.hostedFields) {
      await state.hostedFields.teardown().catch(() => {});
      state.hostedFields = null;
    }
    state.hostedFields = await braintree.hostedFields.create({
      client: state.clientInstance,
      styles: {
        input: { 'font-size': '15px', color: '#1c2733' },
        ':focus': { color: '#1c2733' },
        '.invalid': { color: '#c0392b' },
      },
      fields: {
        number: { selector: '#cc-number', placeholder: '4111 1111 1111 1111' },
        expirationDate: { selector: '#cc-exp', placeholder: 'MM/YY' },
        cvv: { selector: '#cc-cvv', placeholder: '123' },
      },
    });

    // Vault Manager (returning customer).
    state.vaultManager = await braintree.vaultManager.create({ client: state.clientInstance });

    flow.sdk('Hosted Fields mounted (card/expiry/cvv iframes)');
    els.payCardBtn.innerHTML = `Pay ${state.config.amount} ${state.config.currency}`;
    els.payCardBtn.disabled = false;
  } catch (err) {
    flow.error('SDK initialization failed', { message: err.message });
    showResult(els.result, false, 'SDK initialization error', { message: err.message });
  }
}

// ---- Payment with a NEW card (guest / vault) ----
els.payCardBtn.addEventListener('click', async () => {
  const email = els.email.value.trim();
  if (state.scenario === 'vault' && !email) {
    return showResult(els.result, false, 'Email required to save the card in the Vault');
  }

  setLoading(els.payCardBtn, true, 'Tokenization…');
  els.result.className = 'result';
  flow.user(`Click "Pay" — scenario: ${state.scenario}`);

  try {
    // 1) Tokenize the card data (never touched by our server).
    flow.sdk('hostedFields.tokenize() — the card data stays in the Braintree iframes');
    const { nonce, details } = await state.hostedFields.tokenize();
    flow.sdk('Card nonce received', { nonce: maskNonce(nonce), bin: details.bin, cardType: details.cardType, lastFour: details.lastFour });

    // 2) 3D Secure 2: card verification on the nonce.
    setLoading(els.payCardBtn, true, '3D Secure…');
    flow.sdk('threeDSecure.verifyCard() — starting 3DS2', { amount: state.config.amount });
    const threeDSPayload = await state.threeDS.verifyCard({
      amount: state.config.amount,
      nonce,
      bin: details.bin,
      email: email || undefined,
      onLookupComplete: (data, next) => {
        flow.sdk('3DS onLookupComplete', { threeDSecureVersion: data.threeDSecureVersion, liabilityShiftPossible: data.paymentMethod?.threeDSecureInfo?.liabilityShiftPossible });
        next();
      },
    });
    const tdi = threeDSPayload.threeDSecureInfo || {};
    flow.sdk('3DS completed', { liabilityShifted: tdi.liabilityShifted, status: tdi.status, nonce: maskNonce(threeDSPayload.nonce) });

    // 3) Server-side checkout with the 3DS-verified nonce.
    setLoading(els.payCardBtn, true, 'Charge…');
    flow.http('POST /api/checkout', { orderId: orderId.value, vault: state.scenario === 'vault', email: email || '(guest)', requireThreeDSecure: true });
    const data = await api('/api/checkout', {
      method: 'POST',
      body: JSON.stringify({
        paymentMethodNonce: threeDSPayload.nonce,
        deviceData: state.dataCollector.deviceData,
        vault: state.scenario === 'vault',
        email: email || undefined,
        requireThreeDSecure: true,
        orderId: orderId.value,
      }),
    });
    flow.server('Transaction completed', { id: data.transaction.id, orderId: data.transaction.orderId, status: data.transaction.status });
    renderSuccess(data.transaction);
  } catch (err) {
    flow.error('Payment failed', { message: err.message });
    showResult(els.result, false, 'Payment failed', { message: err.message });
  } finally {
    setLoading(els.payCardBtn, false, `Pay ${state.config.amount} ${state.config.currency}`);
    orderId.regenerate(); // new orderId for the next cycle
  }
});

// ---- Load saved methods (buyer present = SDK, buyer not present = server) ----
els.loadVaultBtn.addEventListener('click', async () => {
  const identifier = getIdentifier();
  if (!identifier) {
    return showResult(els.result, false, state.lookupType === 'customerId' ? 'Enter the customer ID' : 'Enter the customer email');
  }

  setLoading(els.loadVaultBtn, true, 'Loading…');
  els.result.className = 'result';
  els.payVaultedBtn.classList.add('hidden');
  try {
    if (state.scenario === 'mit') {
      await loadVaultServerSide(identifier);
    } else {
      await loadVaultClientSide(identifier);
    }
  } catch (err) {
    flow.error('Vault loading error', { message: err.message });
    showResult(els.result, false, 'Vault loading error', { message: err.message });
  } finally {
    setLoading(els.loadVaultBtn, false, state.scenario === 'mit' ? 'Load saved cards (server-side)' : 'Load saved methods');
  }
});

// BUYER PRESENT: reads the methods via client SDK (vaultManager) → gets nonce + 3DS.
async function loadVaultClientSide(identifier) {
  flow.user(`Click "Load saved methods" for ${identifierLabel(identifier)}`);
  await rebuildClient(identifier);
  flow.sdk('vaultManager.fetchPaymentMethods()');
  const methods = await state.vaultManager.fetchPaymentMethods({ defaultFirst: true });
  const cards = methods.filter((m) => m.type === 'CreditCard');
  flow.sdk(`Methods in the Vault: ${methods.length} (cards: ${cards.length})`);

  if (!cards.length) {
    els.vaultedList.innerHTML = '<li>No saved cards. First run a “Checkout + save in the Vault”.</li>';
    return;
  }

  renderVaultList(
    cards.map((m) => ({
      cardType: m.details.cardType,
      last: m.details.lastFour || m.details.lastTwo,
      isDefault: m.default,
    })),
    (idx) => {
      state.selectedMethod = cards[idx];
      state.selectedNonce = cards[idx].nonce;
      state.selectedToken = null;
      flow.user('Method selected (buyer present)', { nonce: maskNonce(cards[idx].nonce) });
    }
  );
}

// BUYER NOT PRESENT: reads the methods ONLY server-side (token) → no client SDK.
async function loadVaultServerSide(identifier) {
  flow.user(`Click "Load saved cards (server-side)" for ${identifierLabel(identifier)}`);
  const path = identifier.customerId
    ? `/api/customers/by-id/${encodeURIComponent(identifier.customerId)}/payment-methods`
    : `/api/customers/${encodeURIComponent(identifier.email)}/payment-methods`;
  flow.http(`GET ${path}`);
  const data = await api(path);
  const cards = (data.paymentMethods || []).filter((m) => m.type === 'CreditCard');
  flow.server(`Methods in the Vault (server-side): ${data.paymentMethods?.length || 0} (cards: ${cards.length})`);

  if (!cards.length) {
    els.vaultedList.innerHTML = '<li>No saved cards. First run a “Checkout + save in the Vault”.</li>';
    return;
  }

  renderVaultList(
    cards.map((m) => ({ cardType: m.cardType, last: m.last4, isDefault: m.default, token: m.token })),
    (idx) => {
      state.selectedMethod = cards[idx];
      state.selectedToken = cards[idx].token;
      state.selectedNonce = null;
      flow.user('Card selected (buyer not present)', { token: cards[idx].token, cardType: cards[idx].cardType });
    }
  );
}

// Renders the list of saved methods and handles the selection.
function renderVaultList(items, onSelect) {
  els.vaultedList.innerHTML = items
    .map(
      (it, i) => `
      <li data-idx="${i}">
        <span>💳 ${escapeHtml(it.cardType || 'Card')} •••• ${escapeHtml(it.last || '••')}</span>
        <span class="meta">${it.isDefault ? 'default' : ''}</span>
      </li>`
    )
    .join('');

  els.vaultedList.querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', () => {
      els.vaultedList.querySelectorAll('li').forEach((x) => x.classList.remove('selected'));
      li.classList.add('selected');
      onSelect(Number(li.dataset.idx));
      els.payVaultedBtn.classList.remove('hidden');
      els.payVaultedBtn.innerHTML =
        state.scenario === 'mit'
          ? `Run server-side charge ${state.config.amount} ${state.config.currency}`
          : `Pay ${state.config.amount} ${state.config.currency}`;
    });
  });
}

// ---- Pay with saved method ----
els.payVaultedBtn.addEventListener('click', async () => {
  const identifier = getIdentifier();
  els.result.className = 'result';
  try {
    if (state.scenario === 'mit') {
      await payMitServerSide(identifier);
    } else {
      await payReturningCustomer(identifier);
    }
  } catch (err) {
    flow.error('Payment failed', { message: err.message });
    showResult(els.result, false, 'Payment failed', { message: err.message });
  } finally {
    setLoading(
      els.payVaultedBtn,
      false,
      state.scenario === 'mit'
        ? `Run server-side charge ${state.config.amount} ${state.config.currency}`
        : `Pay ${state.config.amount} ${state.config.currency}`
    );
    orderId.regenerate(); // new orderId for the next cycle
  }
});

// BUYER PRESENT: 3DS on the saved method's nonce + checkout.
async function payReturningCustomer(identifier) {
  if (!state.selectedNonce) return;
  setLoading(els.payVaultedBtn, true, '3D Secure…');
  flow.user('Click "Pay with selected method" (buyer present)');

  const m = state.selectedMethod;
  flow.sdk('threeDSecure.verifyCard() on the saved method nonce');
  const threeDSPayload = await state.threeDS.verifyCard({
    amount: state.config.amount,
    nonce: state.selectedNonce,
    bin: m.details?.bin,
    email: identifier?.email || undefined,
    onLookupComplete: (data, next) => next(),
  });
  flow.sdk('3DS completed', { liabilityShifted: threeDSPayload.threeDSecureInfo?.liabilityShifted });

  setLoading(els.payVaultedBtn, true, 'Charge…');
  flow.http('POST /api/checkout (returning customer)', { identifier, orderId: orderId.value });
  const data = await api('/api/checkout', {
    method: 'POST',
    body: JSON.stringify({
      paymentMethodNonce: threeDSPayload.nonce,
      deviceData: state.dataCollector.deviceData,
      email: identifier?.email,
      customerId: identifier?.customerId,
      requireThreeDSecure: true,
      orderId: orderId.value,
    }),
  });
  flow.server('Transaction completed', { id: data.transaction.id, orderId: data.transaction.orderId, status: data.transaction.status });
  renderSuccess(data.transaction);
}

// BUYER NOT PRESENT: server-side MIT charge on the token, without 3DS or client SDK.
async function payMitServerSide(identifier) {
  if (!state.selectedToken) return;
  const transactionSource = els.txnSource.value;
  setLoading(els.payVaultedBtn, true, 'Server-side charge…');
  flow.user(`Click "Run server-side charge" (buyer not present, ${transactionSource})`);
  flow.http('POST /api/charge-vaulted (MIT)', { identifier, paymentMethodToken: state.selectedToken, transactionSource, orderId: orderId.value });

  const data = await api('/api/charge-vaulted', {
    method: 'POST',
    body: JSON.stringify({
      email: identifier?.email,
      customerId: identifier?.customerId,
      paymentMethodToken: state.selectedToken,
      transactionSource,
      orderId: orderId.value,
    }),
  });
  flow.server('MIT transaction completed', { id: data.transaction.id, orderId: data.transaction.orderId, status: data.transaction.status, source: transactionSource });
  renderSuccess(data.transaction);
}

function renderSuccess(t) {
  showResult(els.result, true, `✅ Transaction ${t.status} — ${t.amount} ${t.currencyIsoCode}`, t);
  if (t.orderId) {
    els.result.innerHTML += `<div style="margin-top:.4rem">Order ID merchant: <code>${escapeHtml(t.orderId)}</code></div>`;
  }
  if (t.transactionSource) {
    els.result.innerHTML += `<div style="margin-top:.6rem"><span class="badge amber">MIT · ${escapeHtml(t.transactionSource)} (buyer not present, no 3DS)</span></div>`;
  } else {
    els.result.innerHTML += `<div style="margin-top:.6rem">${liabilityBadge(t.threeDSecure)}</div>`;
  }
  if (t.vaultedToken) {
    els.result.innerHTML += `<div style="margin-top:.4rem"><span class="badge green">Method saved in the Vault</span></div>`;
  }
  if (t.dedupedTokens?.length) {
    els.result.innerHTML += `<div style="margin-top:.4rem"><span class="badge amber">Card already in the Vault: removed ${t.dedupedTokens.length} duplicate token(s)</span></div>`;
  }
}
