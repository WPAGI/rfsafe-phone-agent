#!/usr/bin/env node
'use strict';
const http = require('http');
const path = require('path');
const { buildDeps } = require('../src/runtime');
const { createApp } = require('../src/app');
const mode = process.env.PA_MODE === 'live' ? 'live' : 'demo';
const root = path.resolve(__dirname, '..');
const deps = buildDeps({ mode, tenantsDir: process.env.TENANTS_DIR || path.join(root, 'demo/tenants'), dataDir: process.env.DATA_DIR || path.join(root, 'data') });
const { handler } = createApp(deps);
const port = +process.env.PORT || 8787;
http.createServer(handler).listen(port, () => deps.log('server.listening', { port, mode, tenants: deps.tenants.list().map((t) => t.id) }));
