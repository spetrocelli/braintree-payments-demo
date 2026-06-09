# Braintree Demo — Best Practices

A **Braintree** integration demo following current best practices, intended as a technical reference for building a modern payment page.

It covers **three families of payment methods**, each with the *guest*, *checkout with vault*, and *returning customer* flows:

| Method | Guest / one-time | Checkout + Vault | Returning customer |
|---|---|---|---|
| **Card** (Hosted Fields + 3DS2) | ✅ | ✅ | ✅ buyer present (3DS) + ✅ buyer not present (MIT) |
| **PayPal** (+ Pay Later + messaging) | ✅ (checkout) | ✅ (vault / billing agreement) | ✅ buyer present (edit funding source) + ✅ buyer not present (MIT) |
| **Google Pay** | ✅ | — (network token) | — |
| **Apple Pay** | ✅* | — (network token) | — |

\* Apple Pay requires HTTPS + a verified domain (see below).

## Stack

- **Backend**: Node.js + Express — server SDK [`braintree`](https://www.npmjs.com/package/braintree) `^3.37`
- **Frontend**: vanilla HTML/CSS/JS — client SDK [`braintree-web` v3.111](https://braintree.github.io/braintree-web/current/) via CDN
- No client-side framework: the logic for each method is isolated in a single file (`card.js`, `paypal.js`, `wallets.js`) so it can be easily ported to Angular/SSR.

## Implemented best practices

- **Hosted Fields** → card data lives in a Braintree iframe; the server never sees the PAN (PCI **SAQ A**).
- **3D Secure 2** → `threeDSecure.verifyCard()` on the client + `options.threeDSecure.required = true` on the server (rejects if the *liability shift* is missing).
- **Data Collector** → antifraud `deviceData` sent with every transaction.
- **Vault** → `customer.create` + `options.storeInVaultOnSuccess`; the *client token* is generated with a `customerId` to read the saved methods (`vaultManager.fetchPaymentMethods`).
- **Single-use nonce** → no sensitive data is ever sent to the backend; the backend only receives the nonce.
- **CIT vs MIT** → *Customer Initiated* (buyer present): nonce + 3DS. *Merchant Initiated* (buyer not present): server-side charge against the token with `transactionSource` (recurring/installment/unscheduled), per the card networks' "Stored Credentials" framework.
- **Unique orderId** → every transaction carries an `orderId` set by the merchant (displayed and regenerated on each cycle on the card page). It is used for reconciliation and avoids the *"Gateway Rejected: duplicate"* error on otherwise identical charges (same amount + same card within a few seconds). If the client does not send one, the server generates it.
- **Vault dedup** → `transaction.sale` does not expose the `failOnDuplicatePaymentMethod*` options (available only on `clientToken.generate` / `customer.create` / `paymentMethod.create`). Since here we vault during the sale (`storeInVaultOnSuccess`, to preserve 3DS), after saving we perform a **cleanup**: we compare `uniqueNumberIdentifier` and remove duplicate tokens for the same card number, keeping the most recent one.
- **Secret separation** → credentials live only on the server in `.env`; only the *client token* reaches the frontend.

## Setup

```bash
# 1. Dependencies
npm install

# 2. Configuration
cp .env.example .env
#    then enter your Sandbox credentials (Merchant ID, Public Key, Private Key)
#    you can find them at https://sandbox.braintreegateway.com  → Settings → API Keys

# 3. Start
npm start          # production
npm run dev        # development with auto-reload (nodemon)
```

Open **http://localhost:3000**.

### `.env` variables

| Variable | Description |
|---|---|
| `BRAINTREE_ENVIRONMENT` | `sandbox` (default) or `production` |
| `BRAINTREE_MERCHANT_ID` / `_PUBLIC_KEY` / `_PRIVATE_KEY` | API credentials |
| `DEFAULT_CURRENCY` / `DEFAULT_AMOUNT` | amount and currency for the examples |
| `GOOGLE_MERCHANT_ID` | only for Google Pay in production (not needed in sandbox/TEST) |
| `APPLE_PAY_ENABLED` | enables Apple Pay (requires HTTPS + a verified domain) |

> The currency must be supported by the *merchant account*. The default sandbox merchant account is in **USD**: if you use `EUR`, configure a EUR merchant account or change `DEFAULT_CURRENCY`.

## Test cards (Sandbox)

| Card | Number | 3DS behavior |
|---|---|---|
| Visa | `4111 1111 1111 1111` | no challenge |
| Visa (3DS2 challenge) | `4000 0000 0000 1091` | challenge required |
| Visa (3DS2 frictionless, shift) | `4000 0000 0000 1000` | authenticated, liability shift |
| Mastercard | `5555 5555 5555 4444` | — |

Expiration: any future date (e.g. `12/30`) · CVV: `123`.
Full list: [Braintree testing — credit cards](https://developer.paypal.com/braintree/docs/reference/general/testing) and [3DS test cards](https://developer.paypal.com/braintree/docs/guides/3d-secure/testing-go-live).

### PayPal sandbox

To pay in sandbox you need sandbox *buyer* credentials (a personal test account) created from the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/accounts).

## How to try the scenarios

1. **Card + 3DS** (`/card.html`) — four flows:
   - *Guest*: fill in the card → pay (nothing saved).
   - *Checkout + save to Vault*: enter an email → pay → the card stays in the Vault.
   - *Checkout with vault - buyer present* (CIT): same email → “Load saved methods” (via `vaultManager`, client SDK) → select → 3DS → pay.
   - *Checkout with vault - buyer not present* (MIT): same email → “Load saved cards (server-side)” → choose the `transactionSource` (recurring / installment / unscheduled) → **server-side** charge against the saved token, **with no user interaction and no 3DS**. Simulates a scheduled job (utility bill, installment, subscription).
2. **PayPal** (`/paypal.html`) — four flows, with a **PayPal button + a second Pay Later button** wherever applicable and promotional **messaging** in the one-time flows:
   - *Checkout (without Vault)*: one-time payment. PayPal + Pay Later + messaging. In sandbox we force `buyer-country` for Pay Later eligibility (allowed only in sandbox); if not eligible, the page indicates it.
   - *Checkout + Vault*: saves the billing agreement (Pay Later cannot be saved as a billing agreement → indicated).
   - *Checkout with vault - buyer present*: one-time flow + `paypalCheckout.create({ autoSetDataUserIdToken: true })` + client token with `customerId` (vaulted billing agreement). The BT SDK injects the `data-user-id-token` onto the PayPal script → the buyer is recognized: the PayPal button renders **"Pay now"** with the saved method and the **dropdown to change it** (integrated edit funding source), plus the second **Pay Later** button. **Minimal** setup as per the [Vault guide](https://developer.paypal.com/braintree/docs/guides/paypal/vault/javascript/v3/#returning-customer-experience): in this flow we do **not** pass `buyer-country` nor `userAuthenticationEmail` (both force the recognized buyer to log in); only `dataAttributes: { amount }`. `userAction: 'COMMIT'`.
   - *Checkout with vault - buyer not present* (MIT): **server-side** charge against the saved PayPal token with `transactionSource` (recurring/installment/unscheduled). Simulates the payment of an insurance policy/installment.
3. **Google / Apple Pay** (`/wallets.html`)
   - Google Pay: works in TEST environment on Chrome.
   - Apple Pay: see the note below.

## Apple Pay notes

Apple Pay **does not work on `localhost` over HTTP**. To try it you need to:
1. Serve the app over **HTTPS** on a real domain.
2. Register and **verify the domain** in the Braintree Control Panel (Settings → Apple Pay).
3. Use **Safari** on an Apple device with a card in the Wallet.
4. Set `APPLE_PAY_ENABLED=true`.

The page automatically detects availability and shows the button only when the context allows it.

## Observability / Logs

To understand the interactions while using the demo:

- **Frontend** — every page has a **“Payment flow (live log)”** panel that shows each step in real time, with categories:
  - 👤 USER (actions/clicks) · 🟪 CLIENT SDK (braintree-web: tokenize, 3DS, vaultManager) · 🟦 → BACKEND (HTTP requests) · 🟩 ← BACKEND (responses) · 🔴 ERROR.
  - The same events are also in the browser console (DevTools).
- **Backend** — console with timestamps and color-coded categories: `HTTP` (each request with status and duration), `BT` (Braintree calls: client token, customer, `transaction.sale`), `OK`/`WARN`/`ERR`. Nonces are truncated in the logs.

Example (card, checkout + vault):

```
HTTP  POST /api/checkout → ...
BT    Creating new customer in the Vault… {"email":"mario@x.it"}
OK    Customer created {"customerId":"123"}
BT    transaction.sale → {"amount":"54.99","storeInVaultOnSuccess":true,"threeDSecureRequired":true}
OK    Transaction APPROVED {"id":"...","status":"submitted_for_settlement","liabilityShifted":true,"vaulted":true}
```

## Architecture

```
server.js                 # Express: static + API
src/
  gateway.js              # init BraintreeGateway + public config
  store.js                # email → customerId map (JSON, demo)
  routes/
    clientToken.js        # GET  /api/client-token[?email=]
    checkout.js           # POST /api/checkout  (nonce → sale, vault, 3DS)
    customers.js          # GET  /api/customers, /api/customers/:email/payment-methods
public/
  index.html              # landing
  card.html   + js/card.js
  paypal.html + js/paypal.js
  wallets.html+ js/wallets.js
  js/common.js            # shared helpers
  css/styles.css
```

### API endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/config` | public config (env, amount, currency) |
| `GET` | `/api/client-token[?email=]` | client token (with `customerId` if the customer exists) |
| `POST` | `/api/checkout` | `transaction.sale` from a **nonce** (vault/3DS optional) — buyer present |
| `POST` | `/api/charge-vaulted` | `transaction.sale` from a **token** + `transactionSource` (MIT) — buyer not present, no 3DS |
| `POST` | `/api/checkout-saved` | Edit FI buyer present: charges from a **nonce** (if the buyer changed the method) or from the **saved PMT** resolved server-side (if unchanged) |
| `GET` | `/api/customers` | registered demo customers |
| `GET` | `/api/customers/:email/payment-methods` | methods saved in the Vault |

## Porting to other stacks

This demo is intentionally "framework-free". To take it to production:

- **Backend (any language)**: replicate the endpoints with the official server SDK (e.g. [.NET](https://developer.paypal.com/braintree/docs/start/hello-server/dotnet), Java, PHP, Python, Ruby) — `BraintreeGateway`, `Transaction.Sale`, `ClientToken.Generate`. The logic in `src/routes/*` maps 1:1.
- **Frontend (any framework)**: the `card.js` / `paypal.js` / `wallets.js` modules map to your framework's services/components; the `braintree-web` client SDK is also available as an npm package with ESM imports.
- **Returning customer**: the `user → customerId` association belongs in your application DB (here it is the JSON in `data/`, for demo purposes only).

---

⚠️ Demo for demonstration purposes only — do not use production credentials in this repository.
