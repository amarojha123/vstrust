import type { TextResult } from 'pdf-parse';

async function parseDocument(message: unknown): Promise<string> {
  if (!message || typeof message !== 'object' || !('buffer' in message) || !('mimeType' in message) || !Buffer.isBuffer(message.buffer)) throw new Error('Invalid extraction input');
  const buffer = message.buffer;
  if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error('File limit');
  let text: string;
  if (message.mimeType === 'application/pdf') {
    const { PDFParse } = require('pdf-parse') as typeof import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const info = await parser.getInfo();
      if (!Number.isInteger(info.total) || info.total < 1 || info.total > 200) throw new Error('Page limit');
      const result: TextResult = await parser.getText({ first: 200 });
      if (result.pages.some(page => page.text.length > 100000)) throw new Error('Page text limit');
      text = result.text;
    } finally { await parser.destroy(); }
  } else if (message.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = require('mammoth') as typeof import('mammoth');
    text = (await mammoth.extractRawText({ buffer })).value;
  } else throw new Error('Unsupported type');
  // Round-trip through UTF-8 before hashing: malformed parser output becomes
  // scalar Unicode values in the same way as BSON serialization.
  text = Buffer.from(text, 'utf8').toString('utf8').replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim();
  if (!text || text.length > 2_000_000) throw new Error('Text limit');
  return text;
}
function publish(result: { text: string } | { failed: true }) {
  if (process.connected) process.send?.(result, () => { if (process.connected) process.disconnect(); });
}
process.once('message', message => {
  void parseDocument(message).then(text => publish({ text })).catch(() => publish({ failed: true }));
});
