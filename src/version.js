'use strict';
// Product version: the one source of truth is the VERSION file at the repo root (semver, starts at 1.0.0).
// /health, the admin footer and the Edge testing page all read it from here. Prompt versions (bot-defaults.js,
// e.g. 1.9.27) are separate fine print, recorded on each edge-test run; they are never shown as the product version.
// Bump rules are in README.md ("Product version"). package.json "version" must match (checked by test/edge-testing.test.js).
const fs = require('fs'); const path = require('path');
const FILE = path.join(__dirname, '..', 'VERSION');
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
function read(file = FILE) { const v = fs.readFileSync(file, 'utf8').trim(); if (!SEMVER.test(v)) throw new Error('VERSION must be plain semver like 1.0.0'); return v; }
const PRODUCT_VERSION = read();
module.exports = { PRODUCT_VERSION, read, FILE, SEMVER };
