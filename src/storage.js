'use strict';
// DATA_DIR on the Render disk, with a demo fallback when that path cannot be written.
// An empty TENANTS_DIR is seeded once from demo/tenants. Existing files are never overwritten.
const fs = require('fs');
const os = require('os');
const path = require('path');

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function copyMissing(src, dest) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) n += copyMissing(from, to);
    else if (!fs.existsSync(to)) { fs.copyFileSync(from, to); n += 1; }
  }
  return n;
}

function seedIfEmpty(dest, src) {
  fs.mkdirSync(dest, { recursive: true });
  const has = fs.readdirSync(dest).some((f) => f.endsWith('.json'));
  if (has || !fs.existsSync(src)) return false;
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith('.json'))) fs.copyFileSync(path.join(src, f), path.join(dest, f));
  return true;
}

function resolveStorage({ mode, env = process.env, root, log = () => {} }) {
  const seedTenants = path.join(root, 'demo', 'tenants');
  const seedKb = path.join(root, 'demo', 'kb');
  let dataDir = env.DATA_DIR || path.join(root, 'data');
  let fellBack = false;
  if (!isWritable(dataDir)) {
    if (mode === 'live') throw new Error('live mode missing env: DATA_DIR is not writable at ' + dataDir + '. Attach the Render disk mounted at /var/data and set DATA_DIR=/var/data.');
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'callbots-data-'));
    fellBack = true;
    log('storage.fallback', { reason: 'data_dir_unwritable' });
  }
  let tenantsDir;
  if (env.TENANTS_DIR) {
    if (isWritable(env.TENANTS_DIR)) tenantsDir = env.TENANTS_DIR;
    else if (mode === 'live') throw new Error('live mode missing env: TENANTS_DIR is not writable at ' + env.TENANTS_DIR);
    else { tenantsDir = path.join(dataDir, 'tenants'); fellBack = true; log('storage.fallback', { reason: 'tenants_dir_unwritable' }); }
  } else if (env.DATA_DIR) tenantsDir = path.join(dataDir, 'tenants');
  else tenantsDir = seedTenants;

  let seeded = false;
  if (path.resolve(tenantsDir) !== path.resolve(seedTenants)) {
    seeded = seedIfEmpty(tenantsDir, seedTenants);
    const kbDest = path.resolve(tenantsDir, '..', 'kb');
    // KB seed files are copied on every start, but only where missing, so new shipped KB pages reach the disk and edits on disk are kept.
    const added = copyMissing(seedKb, kbDest); if (added) log('kb.seeded', { files: added });
    if (seeded) log('tenants.seeded', { from: 'demo/tenants' });
  }
  return { dataDir, tenantsDir, seeded, fellBack };
}

module.exports = { resolveStorage, isWritable, seedIfEmpty, copyMissing };
