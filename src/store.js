// Minimal file-based store for the demo.
// In production the "application user -> Braintree customerId" association
// lives in your DB (.NET). Here we use a JSON file to make the
// "returning customer" scenario work even after a server restart.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'customers.json');

function read() {
  if (!existsSync(DB_PATH)) return {};
  try {
    return JSON.parse(readFileSync(DB_PATH, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function write(data) {
  writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Returns all registered demo customers: [{ email, customerId, createdAt }]
export function listCustomers() {
  const data = read();
  return Object.values(data).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Looks up a demo customer by email (the application's logical key).
export function findByEmail(email) {
  if (!email) return null;
  return read()[email.toLowerCase()] || null;
}

// Looks up by Braintree customerId.
export function findByCustomerId(customerId) {
  return listCustomers().find((c) => c.customerId === customerId) || null;
}

// Creates/updates the email -> customerId association.
export function saveCustomer({ email, customerId }) {
  const data = read();
  const key = email.toLowerCase();
  data[key] = {
    email,
    customerId,
    createdAt: data[key]?.createdAt || new Date().toISOString(),
  };
  write(data);
  return data[key];
}
