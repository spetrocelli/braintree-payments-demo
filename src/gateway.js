import braintree from 'braintree';
import dotenv from 'dotenv';

dotenv.config();

const required = ['BRAINTREE_MERCHANT_ID', 'BRAINTREE_PUBLIC_KEY', 'BRAINTREE_PRIVATE_KEY'];
const missing = required.filter((k) => !process.env[k] || process.env[k].startsWith('your_'));

if (missing.length) {
  console.warn(
    '\n⚠️  Missing or placeholder Braintree credentials: ' +
      missing.join(', ') +
      '\n   Copy .env.example to .env and enter your sandbox credentials.\n' +
      '   The server starts anyway, but Braintree calls will fail.\n'
  );
}

const environment =
  (process.env.BRAINTREE_ENVIRONMENT || 'sandbox').toLowerCase() === 'production'
    ? braintree.Environment.Production
    : braintree.Environment.Sandbox;

export const gateway = new braintree.BraintreeGateway({
  environment,
  merchantId: process.env.BRAINTREE_MERCHANT_ID,
  publicKey: process.env.BRAINTREE_PUBLIC_KEY,
  privateKey: process.env.BRAINTREE_PRIVATE_KEY,
});

export const config = {
  environment: process.env.BRAINTREE_ENVIRONMENT || 'sandbox',
  currency: process.env.DEFAULT_CURRENCY || 'EUR',
  amount: process.env.DEFAULT_AMOUNT || '54.99',
  googleMerchantId: process.env.GOOGLE_MERCHANT_ID || '',
  applePayEnabled: (process.env.APPLE_PAY_ENABLED || 'false').toLowerCase() === 'true',
};
