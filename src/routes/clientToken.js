import { Router } from 'express';
import { gateway } from '../gateway.js';
import { findByEmail } from '../store.js';
import { log } from '../logger.js';

const router = Router();

// GET /api/client-token
// GET /api/client-token?email=mario@example.com   -> token "tied" to the customer
//
// Generating the client token with the customerId lets the client SDK (vaultManager)
// read the payment methods saved in the Vault -> "returning customer" scenario.
router.get('/client-token', async (req, res) => {
  try {
    const options = {};
    const email = req.query.email;

    if (email) {
      const existing = findByEmail(email);
      if (existing) {
        options.customerId = existing.customerId;
        log.bt(`Client token TIED to customer`, { email, customerId: existing.customerId });
      } else {
        log.bt(`Client token for new customer (email not yet in the Vault)`, { email });
      }
    } else {
      log.bt('Anonymous client token (no customer)');
    }

    const result = await gateway.clientToken.generate(options);
    log.ok('Client token generated');
    res.json({ clientToken: result.clientToken, customerId: options.customerId || null });
  } catch (err) {
    log.err('Client token generation failed', { message: err.message });
    res.status(500).json({ error: 'Unable to generate the client token', detail: err.message });
  }
});

export default router;
