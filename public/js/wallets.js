import { getConfig, getClientToken, showResult, setLoading, highlightNav, api, createFlowLog, maskNonce } from '/js/common.js';

highlightNav();
const flow = createFlowLog('flow-log');
document.getElementById('clear-log').addEventListener('click', () => flow.clear());

let config, clientInstance, dataCollector;

(async function init() {
  config = await getConfig();
  document.getElementById('env-badge').textContent = config.environment;

  flow.http('Requesting client token (anonymous)');
  const { clientToken } = await getClientToken();
  flow.server('Client token received');
  clientInstance = await braintree.client.create({ authorization: clientToken });
  dataCollector = await braintree.dataCollector.create({ client: clientInstance });
  flow.sdk('SDKs ready (client, dataCollector)');

  await setupGooglePay();
  await setupApplePay();
})();

// ============================ GOOGLE PAY ============================
async function setupGooglePay() {
  const container = document.getElementById('googlepay-button-container');
  const result = document.getElementById('gp-result');

  try {
    const googlePayment = await braintree.googlePayment.create({
      client: clientInstance,
      googlePayVersion: 2,
      googleMerchantId: config.googleMerchantId || undefined,
    });

    const paymentsClient = new google.payments.api.PaymentsClient({
      environment: config.environment === 'production' ? 'PRODUCTION' : 'TEST',
    });

    const request = await googlePayment.createPaymentDataRequest({
      transactionInfo: {
        totalPriceStatus: 'FINAL',
        totalPrice: config.amount,
        currencyCode: config.currency,
      },
    });

    const ready = await paymentsClient.isReadyToPay({
      apiVersion: request.apiVersion,
      apiVersionMinor: request.apiVersionMinor,
      allowedPaymentMethods: request.allowedPaymentMethods,
    });

    flow.sdk(`Google Pay isReadyToPay → ${ready.result}`);
    if (!ready.result) {
      container.innerHTML = '<p class="note">Google Pay not available on this browser/device.</p>';
      return;
    }

    const button = paymentsClient.createButton({
      buttonColor: 'black',
      buttonType: 'pay',
      buttonSizeMode: 'fill',
      onClick: async () => {
        result.className = 'result';
        flow.user('Click Google Pay button → opening sheet');
        try {
          const paymentData = await paymentsClient.loadPaymentData(request);
          flow.sdk('Payment data received from Google → parseResponse()');
          const payload = await googlePayment.parseResponse(paymentData);
          flow.sdk('Google Pay nonce received', { nonce: maskNonce(payload.nonce) });

          flow.http('POST /api/checkout');
          const res = await api('/api/checkout', {
            method: 'POST',
            body: JSON.stringify({
              paymentMethodNonce: payload.nonce,
              deviceData: dataCollector.deviceData,
            }),
          });
          flow.server('Transaction completed', { id: res.transaction.id, status: res.transaction.status });
          showResult(result, true, `✅ Google Pay — ${res.transaction.status} ${res.transaction.amount} ${res.transaction.currencyIsoCode}`, res.transaction);
        } catch (err) {
          if (err.statusCode === 'CANCELED') { flow.user('Google Pay cancelled'); return; }
          flow.error('Google Pay payment failed', { message: err.message || String(err) });
          showResult(result, false, 'Google Pay payment failed', { message: err.message || String(err) });
        }
      },
    });
    container.innerHTML = '';
    container.appendChild(button);
  } catch (err) {
    container.innerHTML = '';
    showResult(result, false, 'Google Pay initialization error', { message: err.message });
  }
}

// ============================ APPLE PAY ============================
async function setupApplePay() {
  const container = document.getElementById('applepay-button-container');
  const result = document.getElementById('ap-result');

  // Availability detection.
  if (!window.ApplePaySession || !ApplePaySession.supportsVersion(3) || !ApplePaySession.canMakePayments()) {
    flow.sdk('Apple Pay not available in this context (requires Safari/Apple + HTTPS + verified domain)');
    container.innerHTML = '<p class="note">Apple Pay not available in this context (requires Safari on an Apple device with HTTPS and a verified domain).</p>';
    return;
  }
  flow.sdk('Apple Pay available on this device');

  try {
    const applePay = await braintree.applePay.create({ client: clientInstance });

    const button = document.createElement('button');
    button.className = 'btn';
    button.style.cssText = 'background:#000;width:100%';
    button.textContent = ' Pay with Apple Pay';
    container.innerHTML = '';
    container.appendChild(button);

    button.addEventListener('click', () => {
      result.className = 'result';
      flow.user('Click Apple Pay → starting ApplePaySession');
      const paymentRequest = applePay.createPaymentRequest({
        total: { label: 'Braintree Demo', amount: config.amount },
        currencyCode: config.currency,
        countryCode: 'IT',
      });

      const session = new ApplePaySession(3, paymentRequest);

      session.onvalidatemerchant = (event) => {
        flow.sdk('onvalidatemerchant → performValidation()');
        applePay
          .performValidation({ validationURL: event.validationURL, displayName: 'Braintree Demo' })
          .then((merchantSession) => session.completeMerchantValidation(merchantSession))
          .catch((err) => {
            flow.error('Apple Pay merchant validation failed', { message: err.message });
            session.abort();
            showResult(result, false, 'Apple Pay merchant validation failed', { message: err.message });
          });
      };

      session.onpaymentauthorized = (event) => {
        flow.sdk('onpaymentauthorized → tokenize()');
        applePay
          .tokenize({ token: event.payment.token })
          .then(async (payload) => {
            flow.sdk('Apple Pay nonce received', { nonce: maskNonce(payload.nonce) });
            flow.http('POST /api/checkout');
            const res = await api('/api/checkout', {
              method: 'POST',
              body: JSON.stringify({
                paymentMethodNonce: payload.nonce,
                deviceData: dataCollector.deviceData,
              }),
            });
            session.completePayment(ApplePaySession.STATUS_SUCCESS);
            flow.server('Transaction completed', { id: res.transaction.id, status: res.transaction.status });
            showResult(result, true, `✅ Apple Pay — ${res.transaction.status} ${res.transaction.amount} ${res.transaction.currencyIsoCode}`, res.transaction);
          })
          .catch((err) => {
            session.completePayment(ApplePaySession.STATUS_FAILURE);
            flow.error('Apple Pay payment failed', { message: err.message });
            showResult(result, false, 'Apple Pay payment failed', { message: err.message });
          });
      };

      session.begin();
    });
  } catch (err) {
    container.innerHTML = '';
    showResult(result, false, 'Apple Pay initialization error', { message: err.message });
  }
}
