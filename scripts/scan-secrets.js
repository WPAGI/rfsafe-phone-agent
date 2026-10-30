#!/usr/bin/env node
'use strict';
// Scan a directory (or an unpacked zip) for anything that looks like a secret.
// Usage: node scripts/scan-secrets.js DIR   (exit 1 if anything is found)
const fs = require('fs');
const path = require('path');

const BAD_NAMES = [/^\.env(\..*)?$/, /^smtp\.env$/, /\.eml$/, /^sessions\.jsonl$/, /^ops\.jsonl$/, /^keys\.json$/, /\.pem$/, /\.key$/, /^nonces\.jsonl$/, /^log\.jsonl$/, /^submissions\.jsonl$/, /^config\.json$/, /^secrets\.enc\.json$/, /^consent\.jsonl$/, /^owner-outbox\.jsonl$/, /^secrets\.enc\.json$/, /^consent\.jsonl$/, /^owner-outbox\.jsonl$/, /^id_(rsa|ed25519)/];
const BAD_CONTENT = [
  [/arena_sk_[A-Za-z0-9_-]{20,}/, 'arena publish secret'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'PEM private key'],
  [new RegExp('ar' + 's1\\.s[a-z2-7]{16}\\.[A-Za-z0-9_-]{43}'), 'arena session code'],
  [new RegExp('ARENA_SMTP_' + 'PASSWORD\\s*=\\s*[\'"]?[^\\s\'"#]{4,}'), 'SMTP password value'],
  [/"secret"\s*:\s*"[^"]{16,}"/, 'JSON secret value'],
  [new RegExp('xai-[A-Za-z0-9]{40,}'), 'xAI API key'],
  [new RegExp('\\bAC[0-9a-f]{32}\\b'), 'Twilio account SID'],
  [new RegExp('\\bSK[0-9a-f]{32}\\b'), 'Twilio API key SID'],
  [new RegExp('shp(at|ss|ca|pa)_[0-9a-f]{32}'), 'Shopify token'],
  [new RegExp('whsec_[A-Za-z0-9+/=]{24,}'), 'webhook signing secret'],
  [new RegExp('(XAI_API_KEY|AUTH_TOKEN|MASTER_KEY|ADMIN_TOKEN|STATE_SECRET|WEBHOOK_SECRET)=[^\\s#]{8,}'), 'env secret value'],
  // built from pieces so this file does not match itself
  [new RegExp('(?:' + ['dop' + '_v1_[a-f0-9]{20,}', 'gh' + 'p_[A-Za-z0-9]{20,}', 'github' + '_pat_', 'xox' + '[bap]-[A-Za-z0-9-]{10,}', 's' + 'k-[A-Za-z0-9]{20,}'].join('|') + ')'), 'third-party token'],
];

function scanTree(root, { excludeDirs = [] } = {}) {
  const problems = []; let files = 0;
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name); const rel = path.relative(root, p);
      if (ent.isDirectory()) { if (!excludeDirs.includes(ent.name)) walk(p); continue; }
      files++;
      if (BAD_NAMES.some((re) => re.test(ent.name))) problems.push(`${rel}: forbidden file name`);
      const text = fs.readFileSync(p, 'utf8');
      for (const [re, what] of BAD_CONTENT) if (re.test(text)) problems.push(`${rel}: looks like a ${what}`);
    }
  })(root);
  return { files, problems };
}

if (require.main === module) {
  const r = scanTree(path.resolve(process.argv[2] || '.'), { excludeDirs: ['demo-data', 'node_modules', '.git', 'dist'] });
  if (r.problems.length) { console.error('SECRET SCAN FAILED:\n' + r.problems.join('\n')); process.exit(1); }
  console.log(`secret scan clean: ${r.files} files, 0 findings`);
}
module.exports = { scanTree };
