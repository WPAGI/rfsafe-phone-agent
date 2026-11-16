'use strict';
// Separate worker bounds CPU time and heap for untrusted PDF parsing; no file code is evaluated.
const { parentPort, workerData } = require('node:worker_threads');
const { extractPdfText } = require('./pdftext');
try { parentPort.postMessage({ result: extractPdfText(Buffer.from(workerData.bytes), workerData.options) }); }
catch (e) { parentPort.postMessage({ error: e.status ? e.message : 'pdf_extraction_failed', status: e.status || 422 }); }
