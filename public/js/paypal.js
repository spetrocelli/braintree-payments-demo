import { getConfig, getClientToken, showResult, setLoading, highlightNav, api, escapeHtml, createFlowLog, maskNonce } from '/js/common.js';

highlightNav();
const flow = createFlowLog('flow-log');
document.getElementById('clear-log').addEventListener('click', () => flow.clear());

const state = {
  scenario: 'checkout', // checkout | vault | returning | mit
  config: null,
  clientInstance: null,
  paypalCheckout: null,
  dataCollector: null,
  vaultManager: null,
  selectedToken: null, // saved PayPal for the MIT flow (buyer not present)
};

const els = {
  envBadge: document.getElementById('env-badge'),
  pills: document.getElementById('pills'),
  scnDesc: document.getElementById('scn-desc'),
  email: document.getElementById('email'),
  buttonBlock: document.getElementById('button-block'),
  buttonContainer: document.getElementById('paypal-button-container'),
  payLaterContainer: document.getElementById('paylater-button-container'),
  messagingContainer: document.getElementById('paypal-messaging-container'),
  showReturningBtn: document.getElementById('show-returning-btn'),
  returningBlock: document.getElementById('returning-block'),
  mitOptions: document.getElementById('mit-options'),
  txnSource: document.getElementById('txn-source'),
  loadVaultBtn: document.getElementById('load-vault-btn'),
  vaultedList: document.getElementById('vaulted-list'),
  payVaultedBtn: document.getElementById('pay-vaulted-btn'),
  result: document.getElementById('result'),
};

// Buyer country by currency (only to force Pay Later eligibility in sandbox).
// NB: do NOT use it in the returning flow, because it forces the login of the recognized buyer.
const BUYER_COUNTRY = { EUR: 'IT', GBP: 'GB', USD: 'US', AUD: 'AU' };

// Style shared by the PayPal and Pay Later buttons: same shape/color/height/layout
// for a consistent look (as per PayPal guidelines for stacked buttons).
const BTN_STYLE = { layout: 'vertical', shape: 'rect', color: 'gold', height: 45 };

const DESCRIPTIONS = {
  checkout: 'One-time PayPal payment (flow "checkout"). No saved account. PayPal button + Pay Later + messaging.',
  vault: 'PayPal saved in the Vault via billing agreement (flow "vault") and charged. Requires email. (Pay Later cannot be saved as a billing agreement.)',
  returning:
    'Buyer present: customer with PayPal already in the Vault. Uses the one-time flow + autoSetDataUserIdToken: the button shows the saved account with the "Change payment method" link (edit funding source).',
  mit:
    'Buyer not present (MIT): SERVER-SIDE charge on the saved PayPal (token), without user interaction. Simulates the payment of a recurring policy/installment. transactionSource declared.',
};

(async function init() {
  state.config = await getConfig();
  els.envBadge.textContent = state.config.environment;
  setScenario('checkout');
})();

els.pills.addEventListener('click', (e) => {
  const pill = e.target.closest('.pill');
  if (!pill) return;
  document.querySelectorAll('.pill').forEach((p) => p.classList.remove('active'));
  pill.classList.add('active');
  setScenario(pill.dataset.scn);
});

els.showReturningBtn.addEventListener('click', () => renderButtons('returning'));

async function setScenario(scn) {
  state.scenario = scn;
  els.scnDesc.textContent = DESCRIPTIONS[scn];
  els.result.className = 'result';

  const isMit = scn === 'mit';
  els.buttonBlock.classList.toggle('hidden', isMit);
  els.returningBlock.classList.toggle('hidden', !isMit);
  els.mitOptions.classList.toggle('hidden', !isMit);
  els.showReturningBtn.classList.toggle('hidden', scn !== 'returning');

  // UI reset
  els.buttonContainer.innerHTML = '';
  els.payLaterContainer.innerHTML = '';
  els.messagingContainer.innerHTML = '';
  els.vaultedList.innerHTML = '';
  els.payVaultedBtn.classList.add('hidden');
  state.selectedToken = null;

  if (scn === 'checkout' || scn === 'vault') {
    await renderButtons(scn);
  } else if (scn === 'returning') {
    els.buttonContainer.innerHTML =
      '<p class="note">Enter the customer email and click “Show customer’s saved PayPal”.</p>';
  }
}

// Recreates SDK client, dataCollector, paypalCheckout (with autoSetDataUserIdToken for returning) and vaultManager.
async function rebuildClient(email, { returning = false } = {}) {
  flow.http(`Requesting client token${email ? ` (customer: ${email})` : ' (anonymous)'}`);
  const { clientToken, customerId } = await getClientToken(email);
  flow.server('Client token received', { linkedCustomer: customerId || null });

  state.clientInstance = await braintree.client.create({ authorization: clientToken });
  state.dataCollector = await braintree.dataCollector.create({ client: state.clientInstance, paypal: true });
  state.paypalCheckout = await braintree.paypalCheckout.create({
    client: state.clientInstance,
    // Returning customer: the button shows the saved PayPal + "Change payment method".
    ...(returning ? { autoSetDataUserIdToken: true } : {}),
  });
  if (returning) flow.sdk('paypalCheckout created with autoSetDataUserIdToken: true (edit funding source)');
  state.vaultManager = await braintree.vaultManager.create({ client: state.clientInstance });
}

// Loads the PayPal SDK and renders the buttons (PayPal + Pay Later) for checkout/vault/returning.
async function renderButtons(scn) {
  const vault = scn === 'vault';
  const returning = scn === 'returning';
  els.buttonContainer.innerHTML = '<em style="color:#6b7785">Loading PayPal…</em>';
  els.payLaterContainer.innerHTML = '';
  els.messagingContainer.innerHTML = '';
  els.result.className = 'result';

  const email = els.email.value.trim();
  if (returning && !email) {
    els.buttonContainer.innerHTML = '';
    return showResult(els.result, false, 'Enter the returning customer email');
  }

  try {
    // We always reload the SDK: the client token (anonymous vs customer) and the
    // paypalCheckout instance (autoSetDataUserIdToken) change between scenarios.
    document.querySelectorAll('script[src*="paypal.com/sdk"]').forEach((s) => s.remove());
    delete window.paypal;

    await rebuildClient(returning ? email : undefined, { returning });

    let sdkOpts;
    if (returning) {
      // Vault doc "returning customer experience": MINIMAL setup for one-click
      // without login. NO buyer-country (it would force the login of the recognized buyer)
      // and no userAuthenticationEmail. Only dataAttributes.amount as per the guide.
      sdkOpts = {
        currency: state.config.currency,
        intent: 'capture',
        components: 'buttons,messages',
        'enable-funding': 'paylater',
        dataAttributes: { amount: state.config.amount },
      };
    } else {
      const sandboxBuyerCountry =
        state.config.environment !== 'production'
          ? { 'buyer-country': BUYER_COUNTRY[state.config.currency] || 'IT' }
          : {};
      sdkOpts = {
        currency: state.config.currency,
        components: 'buttons,messages',
        'enable-funding': 'paylater',
        ...sandboxBuyerCountry,
        ...(vault ? { vault: true } : { intent: 'capture' }),
      };
    }

    flow.sdk(`loadPayPalSDK (${scn})`, sdkOpts);
    await state.paypalCheckout.loadPayPalSDK(sdkOpts);

    // DIAGNOSTICS: the "buyer present" one-click without login depends on the
    // PayPal script having the data-user-id-token attribute (buyer recognition).
    const sdkScript = document.querySelector('script[src*="paypal.com/sdk"]');
    const uidTok = sdkScript && sdkScript.getAttribute('data-user-id-token');
    flow.sdk(
      `data-user-id-token on the PayPal script: ${uidTok ? 'PRESENT ✓' : 'ABSENT ✗'}`,
      uidTok ? { length: uidTok.length } : { note: 'without a PayPal token it shows the login (unless an active session exists)' }
    );

    els.buttonContainer.innerHTML = '';

    // 1) Main PayPal button (checkout / vault).
    paypal.Buttons(buildButtonConfig(scn, paypal.FUNDING.PAYPAL)).render('#paypal-button-container');

    // 2) Second Pay Later button — on all experiences; eligibility decided by isEligible().
    const payLater = paypal.Buttons(buildButtonConfig(scn, paypal.FUNDING.PAYLATER));
    if (payLater.isEligible()) {
      payLater.render('#paylater-button-container');
      flow.sdk('Pay Later eligible and rendered');
    } else {
      els.payLaterContainer.innerHTML =
        '<p class="note">Pay Later not eligible in this flow (not savable as a billing agreement, or not available for the currency/country in sandbox).</p>';
      flow.sdk('Pay Later NOT eligible');
    }

    // 3) Promotional messaging in the one-time flows (checkout / returning).
    if (!vault) renderMessaging();
  } catch (err) {
    els.buttonContainer.innerHTML = '';
    flow.error('PayPal loading error', { message: err.message });
    showResult(els.result, false, 'PayPal loading error', { message: err.message });
  }
}

// createPayment for the one-time flows (checkout / returning).
// Minimal as per the docs: no shipping override, no userAuthenticationEmail
// (the latter forced the login of the recognized buyer). enableShippingAddress:false
// (default) → NO_SHIPPING. userAction COMMIT for the "Pay now" CTA.
function createCheckoutPayment({ label }) {
  flow.user(`Opening ${label} (flow: one-time checkout)`);
  return state.paypalCheckout.createPayment({
    flow: 'checkout',
    amount: state.config.amount,
    currency: state.config.currency,
    intent: 'capture',
    userAction: 'COMMIT',
    enableShippingAddress: false,
  });
}

// Shared handlers (tokenize → checkout) for the PayPal/Pay Later buttons.
function paymentHandlers(label, vault) {
  return {
    onApprove: async (data) => {
      els.result.className = 'result';
      flow.sdk(`User approved (${label}) → tokenizePayment()`);
      try {
        const payload = await state.paypalCheckout.tokenizePayment(data);
        flow.sdk('PayPal nonce received', { nonce: maskNonce(payload.nonce), account: payload.details?.email });
        const email = els.email.value.trim();
        if (vault && !email) {
          flow.error('Email missing for saving in the Vault');
          return showResult(els.result, false, 'Email required to save PayPal in the Vault');
        }
        flow.http('POST /api/checkout', { vault, email: email || '(guest)', funding: label });
        const res = await api('/api/checkout', {
          method: 'POST',
          body: JSON.stringify({
            paymentMethodNonce: payload.nonce,
            deviceData: state.dataCollector.deviceData,
            vault,
            email: email || undefined,
          }),
        });
        flow.server('Transaction completed', { id: res.transaction.id, status: res.transaction.status });
        renderSuccess(res.transaction, payload);
      } catch (err) {
        flow.error('PayPal payment failed', { message: err.message });
        showResult(els.result, false, 'PayPal payment failed', { message: err.message });
      }
    },
    onError: (err) => { flow.error(`${label} error`, { message: err.message }); showResult(els.result, false, `${label} error`, { message: err.message }); },
    onCancel: () => { flow.user('Payment cancelled by the user'); showResult(els.result, false, 'Payment cancelled by the user'); },
  };
}

// Configuration of the PayPal/Pay Later buttons.
function buildButtonConfig(scn, fundingSource) {
  const vault = scn === 'vault';
  const label = fundingSource === paypal.FUNDING.PAYLATER ? 'Pay Later' : 'PayPal';
  return {
    fundingSource,
    style: BTN_STYLE,

    ...(vault
      ? {
          createBillingAgreement: () => {
            flow.user('Opening PayPal popup (flow: vault / billing agreement)');
            return state.paypalCheckout.createPayment({
              flow: 'vault',
              userAction: 'SETUP_NOW', // deterministic CTA for the vault flow
            });
          },
        }
      : {
          createOrder: () => createCheckoutPayment({ label }),
        }),

    ...paymentHandlers(label, vault),
  };
}

// Pay Later promotional messaging (e.g. "Pay in 3 interest-free installments").
function renderMessaging() {
  if (!paypal.Messages) {
    flow.sdk('Messaging component not available');
    return;
  }
  els.messagingContainer.innerHTML = '';
  paypal
    .Messages({
      amount: state.config.amount,
      placement: 'payment',
      style: { layout: 'text', logo: { type: 'inline' } },
    })
    .render('#paypal-messaging-container');
  flow.sdk('Pay Later messaging rendered', { amount: state.config.amount });
}

// ===================== Buyer NOT present (MIT) =====================

// Loads the saved PayPals SERVER-SIDE (token) — no client SDK, the user is not there.
els.loadVaultBtn.addEventListener('click', async () => {
  const email = els.email.value.trim();
  if (!email) return showResult(els.result, false, 'Enter the customer email');

  setLoading(els.loadVaultBtn, true, 'Loading…');
  els.result.className = 'result';
  els.payVaultedBtn.classList.add('hidden');
  flow.user(`Click "Load saved PayPals (server-side)" for ${email}`);
  try {
    flow.http(`GET /api/customers/${email}/payment-methods`);
    const data = await api(`/api/customers/${encodeURIComponent(email)}/payment-methods`);
    const accounts = (data.paymentMethods || []).filter((m) => m.type === 'PayPalAccount');
    flow.server(`Methods in the Vault (server-side): ${data.paymentMethods?.length || 0} (PayPal: ${accounts.length})`);

    if (!accounts.length) {
      els.vaultedList.innerHTML = '<li>No saved PayPal. First run a “Checkout + Vault”.</li>';
      return;
    }

    els.vaultedList.innerHTML = accounts
      .map(
        (m, i) => `
        <li data-idx="${i}">
          <span>🅿️ ${escapeHtml(m.email || 'PayPal account')}</span>
          <span class="meta">${m.default ? 'default' : ''}</span>
        </li>`
      )
      .join('');

    els.vaultedList.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () => {
        els.vaultedList.querySelectorAll('li').forEach((x) => x.classList.remove('selected'));
        li.classList.add('selected');
        const acc = accounts[Number(li.dataset.idx)];
        state.selectedToken = acc.token;
        flow.user('Saved PayPal selected (buyer not present)', { account: acc.email, token: acc.token });
        els.payVaultedBtn.classList.remove('hidden');
        els.payVaultedBtn.innerHTML = `Run server-side charge ${state.config.amount} ${state.config.currency}`;
      });
    });
  } catch (err) {
    flow.error('Vault loading error', { message: err.message });
    showResult(els.result, false, 'Vault loading error', { message: err.message });
  } finally {
    setLoading(els.loadVaultBtn, false, 'Load saved PayPals (server-side)');
  }
});

// Server-side MIT charge on the saved PayPal token (no user interaction).
els.payVaultedBtn.addEventListener('click', async () => {
  if (!state.selectedToken) return;
  const email = els.email.value.trim();
  const transactionSource = els.txnSource.value;

  setLoading(els.payVaultedBtn, true, 'Server-side charge…');
  els.result.className = 'result';
  flow.user(`Click "Run server-side charge" (buyer not present, ${transactionSource})`);
  try {
    flow.http('POST /api/charge-vaulted (MIT)', { email, paymentMethodToken: state.selectedToken, transactionSource });
    const res = await api('/api/charge-vaulted', {
      method: 'POST',
      body: JSON.stringify({ email, paymentMethodToken: state.selectedToken, transactionSource }),
    });
    flow.server('MIT transaction completed', { id: res.transaction.id, status: res.transaction.status, source: transactionSource });
    renderSuccess(res.transaction);
  } catch (err) {
    flow.error('Payment failed', { message: err.message });
    showResult(els.result, false, 'Payment failed', { message: err.message });
  } finally {
    setLoading(els.payVaultedBtn, false, `Run server-side charge ${state.config.amount} ${state.config.currency}`);
  }
});

function renderSuccess(t, payload) {
  showResult(els.result, true, `✅ Transaction ${t.status} — ${t.amount} ${t.currencyIsoCode}`, t);
  if (t.orderId) {
    els.result.innerHTML += `<div style="margin-top:.4rem">Order ID merchant: <code>${escapeHtml(t.orderId)}</code></div>`;
  }
  if (payload?.details?.email) {
    els.result.innerHTML += `<div style="margin-top:.4rem"><span class="badge green">Account: ${escapeHtml(payload.details.email)}</span></div>`;
  }
  if (t.transactionSource) {
    els.result.innerHTML += `<div style="margin-top:.4rem"><span class="badge amber">MIT · ${escapeHtml(t.transactionSource)} (buyer not present)</span></div>`;
  }
  if (t.vaultedToken) {
    els.result.innerHTML += `<div style="margin-top:.4rem"><span class="badge green">PayPal saved in the Vault</span></div>`;
  }
}
