// scripts/lib/pdf-metadata.js
// Stamp Title/Author/Subject/Creator onto a Chromium-printed PDF without
// pdf-lib. Chromium writes a classic xref table + trailer, so we append one
// incremental update: a new Info object plus a small xref whose /Prev points
// at the original table. Existing pages/xref are never rewritten.
'use strict';

function pdfText(value) {
  // A hex string with a UTF-16BE BOM is valid for any Unicode title and avoids
  // escaping rules for (), \, and non-ASCII characters.
  const le = Buffer.from(String(value), 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return '<FEFF' + be.toString('hex').toUpperCase() + '>';
}

function stampPdf(input, meta) {
  const buf = Buffer.from(input);
  const tailStart = Math.max(0, buf.length - 65536);
  const tail = buf.subarray(tailStart).toString('latin1');
  const startxrefAt = tail.lastIndexOf('startxref');
  if (startxrefAt < 0) throw new Error('PDF has no startxref');

  const prev = Number((tail.slice(startxrefAt).match(/startxref\s+(\d+)/) || [])[1]);
  if (!Number.isFinite(prev)) throw new Error('PDF startxref is malformed');

  const trailerAt = tail.lastIndexOf('trailer');
  if (trailerAt < 0) throw new Error('PDF has no classic trailer');
  const trailer = tail.slice(trailerAt, startxrefAt);
  const root = (trailer.match(/\/Root\s+(\d+\s+\d+\s+R)/) || [])[1];
  const size = Number((trailer.match(/\/Size\s+(\d+)/) || [])[1]);
  if (!root || !Number.isFinite(size)) throw new Error('PDF trailer has no /Root or /Size');

  // Keep the document's original creation date if it has one.
  const created = (buf.toString('latin1').match(/\/CreationDate\s*\(([^)]*)\)/) || [])[1];
  const id = (trailer.match(/\/ID\s*\[[^\]]*\]/) || [])[0];

  const objNum = size;
  const parts = [
    '/Title ' + pdfText(meta.title || ''),
    '/Author ' + pdfText(meta.author || ''),
    meta.subject ? '/Subject ' + pdfText(meta.subject) : null,
    meta.creator ? '/Creator ' + pdfText(meta.creator) : null,
    created ? '/CreationDate (' + created + ')' : null,
  ].filter(Boolean).join(' ');

  const head = Buffer.from('\n' + objNum + ' 0 obj\n<< ' + parts + ' >>\nendobj\n', 'latin1');
  const objOffset = buf.length + 1;
  const xrefOffset = buf.length + head.length;
  const xref = Buffer.from(
    'xref\n0 1\n0000000000 65535 f \n' +
    objNum + ' 1\n' + String(objOffset).padStart(10, '0') + ' 00000 n \n' +
    'trailer\n<< /Size ' + (objNum + 1) + ' /Root ' + root + ' /Info ' + objNum + ' 0 R' +
    (id ? ' ' + id : '') + ' /Prev ' + prev + ' >>\n' +
    'startxref\n' + xrefOffset + '\n%%EOF\n',
    'latin1'
  );

  return Buffer.concat([buf, head, xref]);
}

module.exports = { stampPdf };
