'use strict';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Deliberately small allowlist: no attributes survive except a freshly validated link.
// Unknown markup becomes inert text; styles, images, forms and embedded content cannot load.
// With { images: true } (only after the owner clicks "Show images") an <img> keeps a validated https src and alt.
function sanitize(input, opts = {}) {
  const allowed = new Set('p br div span h1 h2 h3 h4 strong b em i u ul ol li blockquote pre code hr table tbody thead tr td th a'.split(' '));
  if (opts.images) allowed.add('img');
  const raw = String(input || '').slice(0, 2000000).replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<(script|style|head|title|noscript|template|svg|math|iframe|object|embed|textarea|select|xml)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  return raw.split(/(<[^>]*>)/g).map(part => {
    if (!part.startsWith('<')) return esc(part).replace(/&amp;(#\d+;|#x[0-9a-f]+;|[a-z]+;)/gi, '&$1');
    const m = part.match(/^<(\/?)\s*([a-z0-9]+)(?:\s[^<>]*)?\/?\s*>$/i);
    if (!m || !allowed.has(m[2].toLowerCase())) return '';
    const tag = m[2].toLowerCase();
    if (m[1]) return '</' + tag + '>';
    if (tag === 'a') {
      const a = part.match(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const url = a && (a[1] || a[2] || a[3] || '').trim();
      if (url && /^https?:\/\/[^\s<>"'&]+(?:[^<>"']*)$/i.test(url) && !/[\u0000-\u0020]/.test(url)) return '<a href="' + esc(url) + '" target="_blank" rel="noreferrer noopener">';
    }
    if (tag === 'img') {
      const a = part.match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i); const url = a && (a[1] || a[2] || a[3] || '').trim();
      return url && /^https:\/\/[^\s<>"'&]+(?:[^<>"']*)$/i.test(url) && !/[\u0000-\u0020]/.test(url) ? '<img src="' + esc(url) + '" alt="" style="max-width:100%">' : '';
    }
    return '<' + tag + '>';
  }).join('');
}
function documentHtml(html, opts = {}) { return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src ' + (opts.images ? 'https: data:' : '\'none\'') + '; form-action \'none\'; base-uri \'none\'"><style>body{font:16px/1.65 system-ui;color:#152239;padding:20px;overflow-wrap:anywhere}a{color:#1764c0}pre{white-space:pre-wrap}table{max-width:100%}</style>' + sanitize(html, opts); }
module.exports = { esc, sanitize, documentHtml };
