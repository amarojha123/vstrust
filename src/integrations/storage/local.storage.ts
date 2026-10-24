import { randomUUID } from 'node:crypto';
import { mkdir, open, lstat, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';

function storagePath(key: string) {
  if (!/^[a-f\d]{24}\/[a-f\d-]{36}\.(pdf|docx)$/.test(key)) throw new AppError(400, 'INVALID_STORAGE_KEY', 'Invalid document storage reference');
  const root = path.resolve(env.STORAGE_PATH);
  const resolved = path.resolve(root, ...key.split('/'));
  if (!resolved.startsWith(root + path.sep)) throw new AppError(400, 'INVALID_STORAGE_KEY', 'Invalid document storage reference');
  return resolved;
}

export async function storePrivate(organizationId: string, extension: 'pdf' | 'docx', buffer: Buffer) {
  const key = `${organizationId.toLowerCase()}/${randomUUID()}.${extension}`;
  const target = storagePath(key);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new AppError(500, 'STORAGE_UNAVAILABLE', 'Document storage is unavailable');
  const file = await open(target, 'wx', 0o600);
  try { await file.writeFile(buffer); await file.sync(); } finally { await file.close(); }
  return key;
}

export async function readPrivate(key: string, organizationId: string) {
  if (!key.startsWith(`${organizationId.toLowerCase()}/`)) throw new AppError(404, 'NOT_FOUND', 'Document not found');
  const target = storagePath(key);
  const info = await lstat(target).catch(() => null);
  const directoryInfo = await lstat(path.dirname(target)).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || directoryInfo?.isSymbolicLink()) throw new AppError(404, 'NOT_FOUND', 'Document file not found');
  if (info.size > env.MAX_UPLOAD_BYTES) throw new AppError(422, 'INVALID_FILE', 'Stored document exceeds allowed size');
  return readFile(target);
}

export async function removePrivate(key: string) { await unlink(storagePath(key)).catch(() => undefined); }
