import { createHash } from 'node:crypto';
import path from 'node:path';
import { fork } from 'node:child_process';
import yauzl from 'yauzl';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';

export async function validateDocxArchive(buffer: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, autoClose: true }, (error, zip) => {
      if (error || !zip) { reject(new AppError(422, 'INVALID_DOCX', 'Invalid DOCX archive')); return; }
      let entries = 0;
      let total = 0;
      let document = false;
      let contentTypes = false;
      let failed = false;
      const fail = () => { if (!failed) { failed = true; zip.close(); reject(new AppError(422, 'UNSAFE_DOCX', 'DOCX archive exceeds safety limits or contains unsafe entries')); } };
      zip.on('error', fail);
      zip.on('entry', (entry: yauzl.Entry) => {
        entries++;
        total += entry.uncompressedSize;
        if (entries > 2000 || total > 50 * 1024 * 1024 || entry.uncompressedSize > 20 * 1024 * 1024 || entry.uncompressedSize / Math.max(entry.compressedSize, 1) > 200 || (entry.generalPurposeBitFlag & 1) !== 0 || ![0, 8].includes(entry.compressionMethod) || /(^\/|\\|(^|\/)\.\.(\/|$)|vbaProject|(^|\/)(activeX|embeddings)(\/|$)|\.(exe|dll|js|vbs|ps1|bat|cmd|scr|com)$)/i.test(entry.fileName)) { fail(); return; }
        if (entry.fileName === 'word/document.xml') document = true;
        if (entry.fileName === '[Content_Types].xml') contentTypes = true;
        zip.readEntry();
      });
      zip.on('end', () => { if (!failed) { if (document && contentTypes) resolve(); else reject(new AppError(422, 'INVALID_DOCX', 'Archive is not a DOCX document')); } });
      zip.readEntry();
    });
  });
}

export async function validateUpload(file: Express.Multer.File) {
  if (!file.buffer?.length || file.buffer.length > env.MAX_UPLOAD_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', 'Upload is empty or exceeds the allowed size');
  const extension = path.extname(file.originalname).toLowerCase();
  const isPdf = extension === '.pdf' && file.mimetype === 'application/pdf' && file.buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  const isDocx = extension === '.docx' && file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' && file.buffer[0] === 0x50 && file.buffer[1] === 0x4b && file.buffer[2] === 0x03 && file.buffer[3] === 0x04;
  if (!isPdf && !isDocx) throw new AppError(415, 'UNSUPPORTED_FILE', 'A valid PDF or DOCX file with matching extension and media type is required');
  if (isDocx) await validateDocxArchive(file.buffer);
  const filename = path.basename(file.originalname.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
  return { extension: isPdf ? 'pdf' as const : 'docx' as const, filename, mimeType: file.mimetype, size: file.buffer.length, sha256: createHash('sha256').update(file.buffer).digest('hex') };
}

export async function extractText(buffer: Buffer, mimeType: string): Promise<string> {
  try {
    if (!buffer.length || buffer.length > env.MAX_UPLOAD_BYTES) throw new Error('Invalid file size');
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') await validateDocxArchive(buffer);
    else if (mimeType !== 'application/pdf') throw new Error('Unsupported type');
    // Native PDF addons run in a separate process: a parser crash must not take
    // down an API/queue worker. Node 24 strips .cts types during development;
    // TypeScript emits the corresponding .cjs file for the production build.
    const development = __filename.endsWith('.ts');
    const workerPath = path.join(__dirname, development ? 'extract.worker.cts' : 'extract.worker.cjs');
    const parserEnv = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'NODE_ENV'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    return await new Promise<string>((resolve, reject) => {
      const worker = fork(workerPath, [], {
        execArgv: ['--max-old-space-size=256', ...(development ? ['--experimental-strip-types'] : [])],
        serialization: 'advanced', env: parserEnv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
      });
      let settled = false;
      const finish = (text?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.kill('SIGKILL');
        if (text) resolve(text); else reject(new Error('Extraction worker failed'));
      };
      const timeout = setTimeout(() => finish(), 30000);
      worker.once('message', (message: unknown) => {
        if (message && typeof message === 'object' && 'text' in message && typeof message.text === 'string' && message.text.length <= 2_000_000) finish(message.text);
        else finish();
      });
      worker.once('error', () => finish());
      worker.once('exit', () => { if (!settled) finish(); });
      try { worker.send({ buffer, mimeType }, error => { if (error) finish(); }); } catch { finish(); }
    });
  } catch { throw new AppError(422, 'EXTRACTION_FAILED', 'Document text could not be extracted within the allowed limits'); }
}

export function chunkText(text: string) {
  const chunks: { index: number; text: string; sha256: string }[] = [];
  for (let start = 0; start < text.length; start += 1800) {
    const value = text.slice(start, start + 2000);
    chunks.push({ index: chunks.length, text: value, sha256: createHash('sha256').update(value).digest('hex') });
  }
  return chunks;
}
