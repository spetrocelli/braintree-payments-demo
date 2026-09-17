import { Router } from 'express';
import { gateway } from '../gateway.js';
import { listCustomers, findByEmail } from '../store.js';
import { log } from '../logger.js';

const router = Router();

// GET /api/customers  -> list of demo customers registered in the Vault
router.get('/customers', (req, res) => {
  res.json({ customers: listCustomers() });
});

// GET /api/customers/:email/payment-methods
// Lists the methods saved in the Vault for a customer (server-side).
// NB: to *charge* from a saved method, the client uses vaultManager to obtain
// a single-use nonce; this endpoint is for showing/managing the saved methods.
router.get('/customers/:email/payment-methods', async (req, res) => {
  try {
    const record = findByEmail(req.params.email);
    if (!record) return res.status(404).json({ error: 'Customer not found' });

    log.bt('Reading methods saved in the Vault', { email: record.email, customerId: record.customerId });
    const customer = await gateway.customer.find(record.customerId);
    const methods = (customer.paymentMethods || []).map(serializePaymentMethod);
    log.ok(`Methods found: ${methods.length}`);

    res.json({ customerId: record.customerId, email: record.email, paymentMethods: methods });
  } catch (err) {
    log.err('Error reading payment methods', { message: err.message });
    res.status(500).json({ error: 'Error reading payment methods', detail: err.message });
  }
});

// GET /api/customers/by-id/:customerId/payment-methods
// Same as above, but looks the customer up directly by Braintree customerId
// instead of resolving it from the local email -> customerId store.
router.get('/customers/by-id/:customerId/payment-methods', async (req, res) => {
  const { customerId } = req.params;
  try {
    let customer;
    try {
      customer = await gateway.customer.find(customerId);
    } catch {
      return res.status(404).json({ error: 'Customer not found' });
    }

    log.bt('Reading methods saved in the Vault (by customerId)', { customerId });
    const methods = (customer.paymentMethods || []).map(serializePaymentMethod);
    log.ok(`Methods found: ${methods.length}`);

    res.json({ customerId, email: customer.email || null, paymentMethods: methods });
  } catch (err) {
    log.err('Error reading payment methods', { message: err.message });
    res.status(500).json({ error: 'Error reading payment methods', detail: err.message });
  }
});

function serializePaymentMethod(pm) {
  const base = { token: pm.token, default: pm.default, type: pm.constructor?.name || 'Unknown' };
  if (pm.cardType) {
    return { ...base, type: 'CreditCard', cardType: pm.cardType, last4: pm.last4, expirationDate: `${pm.expirationMonth}/${pm.expirationYear}` };
  }
  if (pm.email) {
    return { ...base, type: 'PayPalAccount', email: pm.email };
  }
  return base;
}

export default router;
