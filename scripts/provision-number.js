#!/usr/bin/env node
'use strict';
// Register the RF Safe number with xAI and point the Twilio SIP trunk at Grok Voice.
// Dry-run unless --apply is passed. The server never runs this. John runs it once, after the number is paid for.
const { buildProvisionPlan, applyProvisionPlan } = require('../src/provision');

const apply = process.argv.includes('--apply');
const plan = buildProvisionPlan({ env: process.env });

if (!apply) {
  console.log(JSON.stringify({ ...plan, note: 'dry-run: no API calls were made. Run again with --apply when the number is bought. This script is never started by the server.' }, null, 2));
  process.exit(0);
}

applyProvisionPlan({
  env: process.env,
  fetchImpl: globalThis.fetch,
  log: (event, fields) => console.error(JSON.stringify({ event, ...fields })),
}).then((result) => {
  console.log('Provisioning finished. Copy the signing secret below into RFSAFE_XAI_WEBHOOK_SECRET now. It is shown once and is not written to a file.');
  console.log(result.webhook_secret || '');
}).catch((err) => { console.error(err.message); process.exit(1); });
