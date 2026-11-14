'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { KB } = require('../src/kb');
test('non-thermal hazards question retrieves the RF Safe non-thermal overview first', () => {
  const kb = new KB({ dirs: [path.join(__dirname, '..', 'kb', 'curated', 'rfsafe')] });
  const hits = kb.search('Cell phone radiation hazards non-thermal effects detail', 3);
  assert.match(hits[0].title, /Non-thermal effects of cell phone radiation/);
});
test('non-thermal entry cites rfsafe.org only', () => {
  const t = fs.readFileSync(path.join(__dirname, '..', 'kb', 'curated', 'rfsafe', 'non-thermal-effects.md'), 'utf8');
  assert.match(t, /^source: https:\/\/rfsafe\.org\//m);
});
