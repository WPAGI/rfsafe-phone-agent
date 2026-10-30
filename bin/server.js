#!/usr/bin/env node
'use strict';
const http = require('http');
const path = require('path');
const { buildDeps, makeLogger, DEMO_ADMIN } = require('../src/runtime');
const { createApp } = require('../src/app');
const { resolveStorage } = require('../src/storage');
const { attachShutdown } = require('../src/shutdown');

const mode = process.env.PA_MODE === 'live' ? 'live' : 'demo';
const root = path.resolve(__dirname, '..');
const secretValues = Object.entries(process.env)
  .filter(([k, v]) => /TOKEN|SECRET|KEY|PASSWORD/i.test(k) && typeof v === 'string' && v.length >= 8)
  .map(([, v]) => v);
const log = makeLogger(process.env.PA_LOG_FILE, secretValues);

let storage;
try { storage = resolveStorage({ mode, env: process.env, root, log }); }
catch (err) { console.error(err.message); process.exit(1); }

let deps;
try { deps = buildDeps({ mode, env: process.env, tenantsDir: storage.tenantsDir, dataDir: storage.dataDir, log }); }
catch (err) { console.error(err.message); process.exit(1); }

if (deps.adminToken === DEMO_ADMIN) deps.log('admin.local_only', { detail: 'Set PA_ADMIN_TOKEN before using /admin on a public host' });

const { handler } = createApp(deps);
const port = Number(process.env.PORT) || 8787;
const server = http.createServer((req, res) => {
  req.setTimeout(30000, () => { if (!res.headersSent) { res.writeHead(408); res.end(); } req.destroy(); });
  Promise.resolve(handler(req, res)).catch((err) => {
    deps.log('http.error', { err: err.message });
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  });
});
server.listen(port, '0.0.0.0', () => deps.log('server.listening', { port, mode, tenants: deps.tenants.list().map((t) => t.id) }));
attachShutdown(server, deps.log);
