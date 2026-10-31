'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');

const cookieOf = (r, name) => { const m = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '=')); return m ? m.slice(name.length + 1) : null; };
const csrfIn = (html) => (html.match(/name="csrf" value="([^"]*)"/) || [])[1];
const post = (base, path, form, cookie) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(form).toString() });
async function emailLink(a) {
  const g = await fetch(a.base + '/admin/login'); const c = cookieOf(g, 'pa_csrf');
  const r = await post(a.base, '/admin/login', { csrf: csrfIn(await g.text()) }, 'pa_csrf=' + c); assert.strictEqual(r.status, 200);
  const m = a.deps.emailFor(null).sent.slice(-1)[0]; return { text: m.text, html: m.html, link: m.text.match(/https?:\/\/\S+\/admin\/auth\S*/)[0] };
}
const authForm = async (a) => { const g = await fetch(a.base + '/admin/auth'); return { g, html: await g.text(), c: cookieOf(g, 'pa_csrf') }; };

test('emailed sign-in link carries the token in the #t= fragment, never ?t=', async () => {
  const a = await startApp();
  try {
    const { text, html, link } = await emailLink(a);
    assert.match(link, /\/admin\/auth#t=[A-Za-z0-9_-]{20,}$/); assert.doesNotMatch(text, /\?t=/); assert.doesNotMatch(html, /\?t=/);
    const { g, html: page } = await authForm(a);
    assert.strictEqual(g.status, 200); assert.ok(csrfIn(page)); assert.match(page, /name="t"/); assert.match(page, /location\.hash/); assert.match(page, /history\.replaceState/); assert.match(page, /Sign in<\/button>/); assert.match(page, /Link expired or used/);
    const csp = g.headers.get('content-security-policy'); const nonce = csp.match(/'nonce-([^']+)'/)[1]; assert.match(page, new RegExp(`<script nonce="${nonce.replace(/[+/=]/g, '\\$&')}">`));
  } finally { await a.close(); }
});

test('legacy GET /admin/auth?t=<valid> neither signs in nor consumes the token; POST still works after', async () => {
  const a = await startApp();
  try {
    const { link } = await emailLink(a); const tok = new URL(link).hash.slice(3);
    const legacy = await fetch(a.base + '/admin/auth?t=' + tok, { redirect: 'manual' });
    assert.strictEqual(legacy.status, 400); assert.strictEqual(cookieOf(legacy, 'pa_admin'), null); assert.ok(!(legacy.headers.get('location') || '').includes(tok));
    const body = await legacy.text(); assert.match(body, /Link expired or used/); assert.ok(!body.includes(tok));
    const { html, c } = await authForm(a);
    const p = await post(a.base, '/admin/auth', { csrf: csrfIn(html), t: tok }, 'pa_csrf=' + c);
    assert.strictEqual(p.status, 303); assert.ok(cookieOf(p, 'pa_admin'));
    assert.strictEqual(p.headers.get('location'), '/admin'); assert.ok(!p.headers.get('location').includes(tok));
  } finally { await a.close(); }
});

test('POST reads the token only from the form body; used or invalid tokens fail', async () => {
  const a = await startApp();
  try {
    const { link } = await emailLink(a); const tok = new URL(link).hash.slice(3);
    let f = await authForm(a);
    const viaQuery = await post(a.base, '/admin/auth?t=' + tok, { csrf: csrfIn(f.html) }, 'pa_csrf=' + f.c);
    assert.strictEqual(viaQuery.status, 400); assert.strictEqual(cookieOf(viaQuery, 'pa_admin'), null);
    f = await authForm(a);
    const bad = await post(a.base, '/admin/auth', { csrf: csrfIn(f.html), t: 'x'.repeat(43) }, 'pa_csrf=' + f.c);
    assert.strictEqual(bad.status, 400); assert.strictEqual(cookieOf(bad, 'pa_admin'), null);
    const ok = await post(a.base, '/admin/auth', { csrf: csrfIn(f.html), t: tok }, 'pa_csrf=' + f.c);
    assert.strictEqual(ok.status, 303); assert.ok(cookieOf(ok, 'pa_admin'));
    f = await authForm(a);
    const reused = await post(a.base, '/admin/auth', { csrf: csrfIn(f.html), t: tok }, 'pa_csrf=' + f.c);
    assert.strictEqual(reused.status, 400); assert.strictEqual(cookieOf(reused, 'pa_admin'), null);
    const nocsrf = await post(a.base, '/admin/auth', { t: tok }, null); assert.strictEqual(nocsrf.status, 403);
  } finally { await a.close(); }
});

test('logs never contain the sign-in token', async () => {
  const a = await startApp();
  try {
    const { link } = await emailLink(a); const tok = new URL(link).hash.slice(3);
    await fetch(a.base + '/admin/auth?t=' + tok);
    const f = await authForm(a); await post(a.base, '/admin/auth?t=' + tok, { csrf: csrfIn(f.html), t: tok }, 'pa_csrf=' + f.c);
    await post(a.base, '/admin/auth', { csrf: csrfIn(f.html), t: tok }, 'pa_csrf=' + f.c);
    await fetch(a.base + '/admin/nope?t=' + tok + '&pin=1234');
    const all = JSON.stringify(a.logs); assert.ok(a.logs.length > 0); assert.ok(!all.includes(tok)); assert.ok(!all.includes('pin=1234'));
  } finally { await a.close(); }
});
