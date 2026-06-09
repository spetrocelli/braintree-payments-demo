import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { config } from './src/gateway.js';
import { requestLogger, log } from './src/logger.js';
import clientTokenRouter from './src/routes/clientToken.js';
import checkoutRouter from './src/routes/checkout.js';
import customersRouter from './src/routes/customers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(requestLogger);
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Public configuration for the frontend (no secrets).
app.get('/api/config', (req, res) => {
  res.json({
    environment: config.environment,
    currency: config.currency,
    amount: config.amount,
    googleMerchantId: config.googleMerchantId,
    applePayEnabled: config.applePayEnabled,
  });
});

// API
app.use('/api', clientTokenRouter);
app.use('/api', checkoutRouter);
app.use('/api', customersRouter);

// Explicit 404: helps identify when a non-existent route is requested
// (e.g. /testpage2). The valid pages are listed below.
app.use((req, res) => {
  log.warn(`Route not found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
    demoPages: ['/', '/card.html', '/paypal.html', '/wallets.html'],
    api: ['/api/config', '/api/client-token', '/api/checkout', '/api/customers'],
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Braintree Demo listening on http://localhost:${PORT}`);
  console.log(`   Environment: ${config.environment} | Currency: ${config.currency} | Demo amount: ${config.amount}\n`);
});
