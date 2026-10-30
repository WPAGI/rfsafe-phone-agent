'use strict';
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http');
const { buildDeps } = require('../src/runtime'); const { createApp } = require('../src/app');
const ENV = { DEMO_XAI_WEBHOOK_SECRET: 'whsec_' + Buffer.from('test-secret').toString('base64'), DEMO_TWILIO_AUTH_TOKEN: 'tw-test', DEMO_ACME_XAI_WEBHOOK_SECRET: 'acme-secret', DEMO_ACME_TWILIO_AUTH_TOKEN: 'acme-tw' };
async function startApp(over = {}) {
  const logs = [];
  const deps = buildDeps({ mode: 'demo', env: ENV, tenantsDir: path.join(__dirname, '../demo/tenants'), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pa-t-')), log: (e, f) => logs.push({ e, ...f }) });
  deps.now = over.now || (() => new Date('2026-10-29T14:00:00Z')); // Thu 10:00 ET
  // keep tenant files untouched in tests
  deps.tenants.save = () => {};
  let lastWs; const orig = deps.openRealtime; deps.openRealtime = async (...a) => (lastWs = await orig(...a));
  const app = createApp(deps); const srv = http.createServer(app.handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port; deps.publicBaseUrl = base;
  return { deps, app, base, logs, ws: () => lastWs, close: () => new Promise((r) => srv.close(r)) };
}
module.exports = { startApp, ENV };
