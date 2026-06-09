// Minimal logger with timestamp and categories, to make the demo's
// iterations easy to read directly in the console.

const COLORS = {
  http: '\x1b[36m', // cyan
  bt: '\x1b[35m', // magenta (Braintree)
  ok: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  err: '\x1b[31m', // red
  dim: '\x1b[90m',
};
const RESET = '\x1b[0m';

function ts() {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

function line(color, tag, msg, data) {
  let out = `${COLORS.dim}${ts()}${RESET} ${color}${tag}${RESET} ${msg}`;
  if (data !== undefined) {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    out += ` ${COLORS.dim}${str}${RESET}`;
  }
  console.log(out);
}

export const log = {
  http: (msg, data) => line(COLORS.http, 'HTTP ', msg, data),
  bt: (msg, data) => line(COLORS.bt, 'BT   ', msg, data), // Braintree call
  ok: (msg, data) => line(COLORS.ok, 'OK   ', msg, data),
  warn: (msg, data) => line(COLORS.warn, 'WARN ', msg, data),
  err: (msg, data) => line(COLORS.err, 'ERR  ', msg, data),
};

// Express middleware: logs every request with method, path, status and duration.
export function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const color =
      res.statusCode >= 500 ? COLORS.err : res.statusCode >= 400 ? COLORS.warn : COLORS.http;
    line(color, 'HTTP ', `${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
  });
  next();
}
