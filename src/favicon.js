'use strict';
// 16x16 icon, drawn in code so the homepage does not depend on a binary asset.
function faviconIco() {
  const size = 16;
  const header = 22;
  const xor = size * size * 4;
  const and = 4 * size;
  const bytes = 40 + xor + and;
  const buf = Buffer.alloc(header + bytes);
  buf.writeUInt16LE(0, 0);
  buf.writeUInt16LE(1, 2);
  buf.writeUInt16LE(1, 4);
  buf.writeUInt8(size, 6);
  buf.writeUInt8(size, 7);
  buf.writeUInt16LE(1, 10);
  buf.writeUInt16LE(32, 12);
  buf.writeUInt32LE(bytes, 14);
  buf.writeUInt32LE(header, 18);
  buf.writeUInt32LE(40, header);
  buf.writeInt32LE(size, header + 4);
  buf.writeInt32LE(size * 2, header + 8);
  buf.writeUInt16LE(1, header + 12);
  buf.writeUInt16LE(32, header + 14);
  const px = header + 40;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = px + ((size - 1 - y) * size + x) * 4;
      const edge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      const mark = x >= 4 && x <= 11 && y >= 3 && y <= 12 && (x <= 6 || y <= 5 || y >= 10);
      buf[i] = edge ? 0x1a : mark ? 0xe7 : 0x2f;
      buf[i + 1] = edge ? 0x2a : mark ? 0xf0 : 0x38;
      buf[i + 2] = edge ? 0x24 : mark ? 0xf4 : 0x12;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

const FAVICON_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <title>CallBots</title>
  <rect width="32" height="32" rx="6" fill="#12382f"/>
  <path d="M9 8h8a2 2 0 0 1 2 2v4H15V12H11v8h4v-2h4v4a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z" fill="#f4f1ea"/>
</svg>`;

let ico;
function faviconIcoCached() { return ico || (ico = faviconIco()); }

module.exports = { faviconIco: faviconIcoCached, FAVICON_SVG };
