import { Router } from 'express';
import { gateway, config } from '../gateway.js';
import { findByEmail, saveCustomer } from '../store.js';
import { log } from '../logger.js';

const router = Router();

/**
 * POST /api/checkout
 *
 * Single endpoint for all payment methods (card via Hosted Fields,
 * PayPal, Google Pay, Apple Pay). Receives a single-use nonce from the client.
 *
 * Body:
 *   paymentMethodNonce  (string)  nonce from the client SDK         [required]
 *   amount              (string)  amount; defaults from .env
 *   deviceData          (string)  Data Collector device data (fraud prevention)
 *   vault               (bool)    if true -> saves the method in the Vault (checkout with vault)
 *   email               (string)  identifies/creates the customer (required for the Vault)
 *   firstName,lastName  (string)  customer details (optional)
 *   requireThreeDSecure (bool)    if true -> Braintree declines if the liability shift is missing
 */
router.post('/checkout', async (req, res) => {
  const {
    paymentMethodNonce,
    amount,
    deviceData,
    vault = false,
    email,
    customerId: providedCustomerId,
    firstName,
    lastName,
    requireThreeDSecure = false,
    orderId,
  } = req.body;

  if (!paymentMethodNonce) {
    return res.status(400).json({ error: 'paymentMethodNonce missing' });
  }

  // orderId = order identifier set by the merchant. Unique for each
  // attempt: used for reconciliation and to distinguish otherwise identical charges.
  const merchantOrderId = orderId || genOrderId();

  log.http('Checkout received', {
    vault,
    email: email || '(guest)',
    requireThreeDSecure,
    orderId: merchantOrderId,
    nonce: maskNonce(paymentMethodNonce),
    deviceData: deviceData ? 'present' : 'absent',
  });

  try {
    // 1) Resolve/create the customer if we need to tie it to the Vault or if it's a returning one.
    let customerId = providedCustomerId || null;
    if (!customerId && email) {
      const existing = findByEmail(email);
      if (existing) {
        customerId = existing.customerId;
        log.bt('Existing customer found in the Vault', { email, customerId });
      }
    }

    if (vault && !customerId) {
      if (!email) {
        return res.status(400).json({ error: 'Email required to save the method in the Vault' });
      }
      log.bt('Creating new customer in the Vault…', { email });
      const custResult = await gateway.customer.create({ email, firstName, lastName });
      if (!custResult.success) {
        log.err('Customer creation failed', { message: custResult.message });
        return res.status(422).json({ error: 'Customer creation failed', detail: custResult.message });
      }
      customerId = custResult.customer.id;
      saveCustomer({ email, customerId });
      log.ok('Customer created', { customerId });
    }

    // 2) Build the transaction request.
    const saleRequest = {
      amount: amount || config.amount,
      paymentMethodNonce,
      orderId: merchantOrderId,
      options: {
        submitForSettlement: true,
      },
    };

    if (deviceData) saleRequest.deviceData = deviceData;

    // Tie/save to the customer.
    if (customerId) saleRequest.customerId = customerId;
    if (vault) saleRequest.options.storeInVaultOnSuccess = true;

    // Best practice: require the 3DS liability shift for cards.
    if (requireThreeDSecure) {
      saleRequest.options.threeDSecure = { required: true };
    }

    // 3) Run the sale.
    log.bt('transaction.sale →', {
      amount: saleRequest.amount,
      submitForSettlement: true,
      storeInVaultOnSuccess: !!saleRequest.options.storeInVaultOnSuccess,
      threeDSecureRequired: !!saleRequest.options.threeDSecure?.required,
      customerId: saleRequest.customerId || null,
    });
    const result = await gateway.transaction.sale(saleRequest);

    if (!result.success) {
      log.err('Transaction DECLINED', {
        message: result.message,
        status: result.transaction?.status,
        processor: result.transaction?.processorResponseText,
      });
      return res.status(422).json({
        success: false,
        error: result.message,
        // Codes useful for 3DS / processor debugging.
        processorResponse: result.transaction
          ? {
              status: result.transaction.status,
              processorResponseCode: result.transaction.processorResponseCode,
              processorResponseText: result.transaction.processorResponseText,
            }
          : null,
      });
    }

    const t = result.transaction;
    log.ok('Transaction APPROVED', {
      id: t.id,
      status: t.status,
      amount: `${t.amount} ${t.currencyIsoCode}`,
      instrument: t.paymentInstrumentType,
      liabilityShifted: t.threeDSecureInfo?.liabilityShifted ?? 'n/a',
      vaulted: !!(t.creditCard?.token || t.paypalAccount?.token),
    });

    const txn = serializeTransaction(t);

    // Post-vault cleanup: if we saved a card, delete any duplicate tokens
    // for the same card number (same uniqueNumberIdentifier),
    // keeping only the most recent one. transaction.sale does not support failOnDuplicate*,
    // so we deduplicate here after saving (3DS preserved on the sale).
    if (vault && customerId) {
      try {
        const removed = await dedupeCustomerCards(customerId);
        if (removed.length) {
          txn.dedupedTokens = removed;
          log.ok(`Vault dedup: removed ${removed.length} duplicate tokens`);
        }
      } catch (e) {
        log.warn('Vault dedup failed (transaction still ok)', { message: e.message });
      }
    }

    res.json({ success: true, transaction: txn });
  } catch (err) {
    log.err('Error during checkout', { message: err.message });
    res.status(500).json({ error: 'Error during checkout', detail: err.message });
  }
});

// Deletes duplicate tokens for the same card number for a customer,
// keeping only the most recent one. Returns the removed tokens.
async function dedupeCustomerCards(customerId) {
  const customer = await gateway.customer.find(customerId);
  const byUid = {};
  for (const cc of customer.creditCards || []) {
    if (!cc.uniqueNumberIdentifier) continue;
    (byUid[cc.uniqueNumberIdentifier] ||= []).push(cc);
  }

  const removed = [];
  for (const group of Object.values(byUid)) {
    if (group.length <= 1) continue;
    group.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // most recent first
    const keep = group[0];
    for (const dup of group.slice(1)) {
      await gateway.paymentMethod.delete(dup.token);
      removed.push(dup.token);
    }
    log.bt(`Vault dedup card ••${keep.last4}: kept ${keep.token}, removed [${group.slice(1).map((d) => d.token).join(', ')}]`);
  }
  return removed;
}

/**
 * POST /api/charge-vaulted  — Merchant Initiated Transaction (MIT), "buyer not present"
 *
 * SERVER-SIDE charge on a card already in the Vault, with no user interaction
 * nor 3D Secure. Typical of recurring/scheduled payments: utility bill, installment, subscription.
 * It uses the payment method TOKEN (not a nonce) and declares the MIT nature with
 * `transactionSource` (recurring / unscheduled / installment), part of the card networks'
 * "Stored Credentials" framework.
 *
 * Body:
 *   email             (string)  customer in the Vault (or customerId below)  [required, one of]
 *   customerId        (string)  Braintree customer id, alternative to email  [required, one of]
 *   paymentMethodToken(string)  token of the saved method                 [required]
 *   amount            (string)  amount; defaults from .env
 *   transactionSource (string)  recurring | unscheduled | installment ...  (default: recurring)
 */
const VALID_SOURCES = ['recurring', 'recurring_first', 'unscheduled', 'installment', 'installment_first', 'moto'];

router.post('/charge-vaulted', async (req, res) => {
  const { email, customerId, paymentMethodToken, amount, transactionSource = 'recurring', orderId } = req.body;

  if (!paymentMethodToken) return res.status(400).json({ error: 'paymentMethodToken missing' });
  if (!email && !customerId) return res.status(400).json({ error: 'customer email or customerId missing' });
  if (!VALID_SOURCES.includes(transactionSource)) {
    return res.status(400).json({ error: `invalid transactionSource (allowed: ${VALID_SOURCES.join(', ')})` });
  }

  const merchantOrderId = orderId || genOrderId();

  log.http('Charge-vaulted (MIT / buyer not present)', {
    email: email || undefined,
    customerId: customerId || undefined,
    paymentMethodToken,
    transactionSource,
    orderId: merchantOrderId,
    amount: amount || config.amount,
  });

  try {
    if (customerId) {
      log.bt('MIT charge identified by customerId', { customerId });
    } else {
      const customer = findByEmail(email);
      if (!customer) return res.status(404).json({ error: 'Customer not found in the Vault' });
    }

    // No nonce, no 3DS: direct charge on the saved token.
    log.bt('transaction.sale (MIT) →', {
      paymentMethodToken,
      transactionSource,
      orderId: merchantOrderId,
      amount: amount || config.amount,
    });
    const result = await gateway.transaction.sale({
      amount: amount || config.amount,
      paymentMethodToken,
      transactionSource, // declares the transaction as merchant-initiated
      orderId: merchantOrderId,
      options: { submitForSettlement: true },
    });

    if (!result.success) {
      log.err('MIT DECLINED', { message: result.message, status: result.transaction?.status });
      return res.status(422).json({
        success: false,
        error: result.message,
        processorResponse: result.transaction
          ? { status: result.transaction.status, processorResponseText: result.transaction.processorResponseText }
          : null,
      });
    }

    const t = result.transaction;
    log.ok('MIT APPROVED', { id: t.id, status: t.status, amount: `${t.amount} ${t.currencyIsoCode}`, source: t.recurring });
    res.json({ success: true, transaction: { ...serializeTransaction(t), transactionSource } });
  } catch (err) {
    log.err('Error during charge-vaulted', { message: err.message });
    res.status(500).json({ error: 'Error during the charge', detail: err.message });
  }
});

/**
 * POST /api/checkout-saved  — Edit FI (buyer present, one-click with "Edit Funding Source")
 *
 * Two paths, as per the Braintree Edit FI guide:
 *  - if the buyer changed the method in the SavedPaymentMethods widget → a `nonce` arrives
 *    (from tokenizePayment) and we charge on that;
 *  - otherwise (no change) → we charge on the customer's already-saved PayPal PMT,
 *    resolved SERVER-SIDE from the email (the token never transits from the client).
 *
 * Body: { email, nonce?, amount?, deviceData?, orderId? }
 */
router.post('/checkout-saved', async (req, res) => {
  const { email, nonce, amount, deviceData, orderId } = req.body;
  if (!email) return res.status(400).json({ error: 'customer email missing' });

  const customer = findByEmail(email);
  if (!customer) return res.status(404).json({ error: 'Customer not found in the Vault' });

  const merchantOrderId = orderId || genOrderId();
  const saleRequest = {
    amount: amount || config.amount,
    orderId: merchantOrderId,
    options: { submitForSettlement: true },
  };
  if (deviceData) saleRequest.deviceData = deviceData;

  try {
    if (nonce) {
      // The buyer changed the funding source in the widget → new nonce.
      saleRequest.paymentMethodNonce = nonce;
      saleRequest.customerId = customer.customerId;
      log.http('Checkout-saved: buyer CHANGED method (nonce)', { email, orderId: merchantOrderId, nonce: maskNonce(nonce) });
    } else {
      // No change → charge on the already-saved PayPal (resolved server-side).
      const c = await gateway.customer.find(customer.customerId);
      const pp = (c.paypalAccounts || []).slice().sort((a, b) => (b.default === true) - (a.default === true))[0];
      if (!pp) return res.status(404).json({ error: 'No PayPal saved for the customer' });
      saleRequest.paymentMethodToken = pp.token;
      log.http('Checkout-saved: no change → existing PMT', { email, orderId: merchantOrderId, paymentMethodToken: pp.token, account: pp.email });
    }

    log.bt('transaction.sale (Edit FI buyer present) →', {
      via: nonce ? 'nonce' : 'paymentMethodToken',
      amount: saleRequest.amount,
      orderId: merchantOrderId,
    });
    const result = await gateway.transaction.sale(saleRequest);

    if (!result.success) {
      log.err('Checkout-saved DECLINED', { message: result.message, status: result.transaction?.status });
      return res.status(422).json({ success: false, error: result.message });
    }

    const t = result.transaction;
    log.ok('Checkout-saved APPROVED', { id: t.id, status: t.status, amount: `${t.amount} ${t.currencyIsoCode}`, via: nonce ? 'nonce' : 'token' });
    res.json({ success: true, transaction: { ...serializeTransaction(t), editFunding: !!nonce } });
  } catch (err) {
    log.err('Error during checkout-saved', { message: err.message });
    res.status(500).json({ error: 'Error during the charge', detail: err.message });
  }
});

// Shows only the start of the nonce in logs (they're single-use tokens, but we avoid printing them in full).
function maskNonce(n) {
  return typeof n === 'string' && n.length > 12 ? `${n.slice(0, 12)}…` : n;
}

// Generates a unique merchant orderId (fallback if the client does not send one).
function genOrderId() {
  return `DEMO-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function serializeTransaction(t) {
  const out = {
    id: t.id,
    orderId: t.orderId,
    status: t.status,
    amount: t.amount,
    currencyIsoCode: t.currencyIsoCode,
    paymentInstrumentType: t.paymentInstrumentType,
    createdAt: t.createdAt,
  };

  // Token of the method saved in the Vault (if present).
  out.vaultedToken =
    t.creditCard?.token || t.paypalAccount?.token || t.androidPayCard?.token || t.applePayCard?.token || null;

  // 3D Secure summary.
  if (t.threeDSecureInfo) {
    out.threeDSecure = {
      status: t.threeDSecureInfo.status,
      liabilityShifted: t.threeDSecureInfo.liabilityShifted,
      liabilityShiftPossible: t.threeDSecureInfo.liabilityShiftPossible,
      version: t.threeDSecureInfo.threeDSecureVersion,
    };
  }

  // Instrument details.
  if (t.creditCard?.last4) {
    out.instrument = { type: 'card', cardType: t.creditCard.cardType, last4: t.creditCard.last4 };
  } else if (t.paypalAccount?.payerEmail) {
    out.instrument = { type: 'paypal', email: t.paypalAccount.payerEmail };
  }

  return out;
}

export default router;
