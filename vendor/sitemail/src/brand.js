'use strict';
// Business identity for this deployment (one business per service: "separate everything").
// Loaded from deploy/brand.json, or the file named by BRAND_FILE. A new business copy edits only that file.
const fs = require('fs'); const path = require('path');
const file = process.env.BRAND_FILE || path.join(__dirname, '..', 'deploy', 'brand.json');
const B = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const k of ['id', 'name', 'company', 'product', 'site', 'store', 'domain', 'from']) if (!B[k]) throw new Error('brand.json missing ' + k);
B.publicUrl = 'https://' + B.domain;
B.fromAddr = (B.from.match(/<([^>]+)>/) || [, B.from])[1];
B.esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
module.exports = Object.freeze(B);
