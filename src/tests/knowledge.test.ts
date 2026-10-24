import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { AuditEvent, Job, KnowledgeChunk, KnowledgeDocument, Membership } from '../models';
import { clearDatabase, closeTestDatabase, setupTestDatabase, verifiedUser } from './helpers';
import { buildKnowledgeSnapshot } from '../services/brand.service';
import { processDocumentJob } from '../jobs/handlers';
import { extractText, validateDocxArchive } from '../integrations/storage/extract';
import { env } from '../config/env';

// A real minimal DOCX ZIP, constructed without a filesystem or external fixture fetch.
function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries: Record<string, string>) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const filename = Buffer.from(name);
    const data = Buffer.from(text);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc32(data), 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename); offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const docx = () => zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Trust Mark approved claims require evidence.</w:t></w:r></w:p></w:body></w:document>',
});
const docxType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function pdf() {
  const stream = 'BT /F1 12 Tf 50 700 Td (Trust Mark verified policy.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
const rule = { title: 'Claim accuracy', description: 'Only make claims backed by evidence.', category: 'accuracy', severity: 'high' };
const base = (organization: any) => `/api/v1/organizations/${String(organization._id)}`;

beforeAll(setupTestDatabase);
beforeEach(clearDatabase);
afterAll(closeTestDatabase);

describe('brand knowledge lifecycle and tenant authorization', () => {
  it('only includes explicitly published knowledge and brand profile in scan snapshots', async () => {
    const account = await verifiedUser();
    const root = base(account.organization);
    const profile = await request(app).post(`${root}/brand-profile`).set(account.headers).send({ name: 'Trust Mark', voice: 'Calm and precise' });
    expect(profile.status).toBe(201);
    const created = await request(app).post(`${root}/guidelines`).set(account.headers).send(rule);
    expect(created.status).toBe(201);
    const id = created.body.data._id;
    expect((await buildKnowledgeSnapshot(String(account.organization._id))).guidelines).toHaveLength(0);
    const published = await request(app).post(`${root}/guidelines/${id}/publish`).set(account.headers).send({ version: 0 });
    expect(published.status).toBe(200);
    const snapshot = await buildKnowledgeSnapshot(String(account.organization._id));
    expect(snapshot.guidelines[0]?.id).toBe(id);
    expect(snapshot.brandProfile?.voice).toBe('Calm and precise');
    const updated = await request(app).patch(`${root}/guidelines/${id}`).set(account.headers).send({ version: 1, description: 'Updated claims policy.' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.status).toBe('draft');
    expect((await buildKnowledgeSnapshot(String(account.organization._id))).guidelines).toHaveLength(0);
  });

  it('prevents cross-organization reads/writes and rejects stale concurrent versions', async () => {
    const alice = await verifiedUser('alice@knowledge.test', 'Alice org');
    const bob = await verifiedUser('bob@knowledge.test', 'Bob org');
    const created = await request(app).post(`${base(alice.organization)}/guidelines`).set(alice.headers).send(rule);
    const id = created.body.data._id;
    expect((await request(app).get(`${base(bob.organization)}/guidelines/${id}`).set(bob.headers)).status).toBe(404);
    expect((await request(app).patch(`${base(bob.organization)}/guidelines/${id}`).set(bob.headers).send({ version: 0, title: 'Stolen' })).status).toBe(404);
    expect((await request(app).get(`${base(alice.organization)}/guidelines/${id}`).set(bob.headers)).status).toBe(404);
    const updates = await Promise.all(['Update one', 'Update two'].map(title => request(app).patch(`${base(alice.organization)}/guidelines/${id}`).set(alice.headers).send({ version: 0, title })));
    expect(updates.map(response => response.status).sort()).toEqual([200, 409]);
    expect(await AuditEvent.countDocuments({ organizationId: alice.organization._id, action: 'brand.knowledge.updated' })).toBe(1);
  });

  it('enforces server roles and rejects operator injection and unknown mutable fields', async () => {
    const account = await verifiedUser();
    await Membership.updateOne({ organizationId: account.organization._id, userId: account.user._id }, { $set: { role: 'auditor' } });
    expect((await request(app).post(`${base(account.organization)}/guidelines`).set(account.headers).send(rule)).status).toBe(403);
    await Membership.updateOne({ organizationId: account.organization._id, userId: account.user._id }, { $set: { role: 'admin' } });
    expect((await request(app).post(`${base(account.organization)}/guidelines`).set(account.headers).send({ ...rule, organizationId: 'a'.repeat(24) })).status).toBe(400);
    expect((await request(app).post(`${base(account.organization)}/guidelines`).set(account.headers).send({ ...rule, title: { $ne: null } })).status).toBe(400);
  });

  it('keeps omitted profile and terminology fields unchanged on partial updates', async () => {
    const account = await verifiedUser();
    const root = base(account.organization);
    const profile = await request(app).post(`${root}/brand-profile`).set(account.headers).send({ name: 'Original', voice: 'Precise', tone: 'Calm' });
    expect(profile.status).toBe(201);
    const changed = await request(app).patch(`${root}/brand-profile`).set(account.headers).send({ version: 0, name: 'Renamed' });
    expect(changed.status).toBe(200);
    expect(changed.body.data.voice).toBe('Precise');
    expect(changed.body.data.tone).toBe('Calm');
    const term = await request(app).post(`${root}/terminology-rules`).set(account.headers).send({ term: 'TRUST MARK', replacement: 'Trust Mark', caseSensitive: true, description: 'Use official capitalization' });
    expect(term.status).toBe(201);
    const termUpdate = await request(app).patch(`${root}/terminology-rules/${term.body.data._id}`).set(account.headers).send({ version: 0, description: 'Use brand capitalization' });
    expect(termUpdate.status).toBe(200);
    expect(termUpdate.body.data.caseSensitive).toBe(true);
    expect(termUpdate.body.data.replacement).toBe('Trust Mark');
  });
});

describe('private document upload and processing', () => {
  it('extracts a genuine PDF and accepts its matching file signature and media type', async () => {
    const account = await verifiedUser();
    const upload = await request(app).post(`${base(account.organization)}/documents`).set(account.headers).attach('file', pdf(), { filename: 'policy.pdf', contentType: 'application/pdf' });
    expect(upload.status).toBe(202);
    await expect(extractText(pdf(), 'application/pdf')).resolves.toContain('Trust Mark verified policy.');
  });
  it('uploads a genuine DOCX, processes bounded chunks, publishes, and audits private download', async () => {
    const account = await verifiedUser();
    const root = base(account.organization);
    const upload = await request(app).post(`${root}/documents`).set(account.headers).attach('file', docx(), { filename: 'claims.docx', contentType: docxType });
    expect(upload.status).toBe(202);
    expect(upload.body.data.storageKey).toBeUndefined();
    const id = upload.body.data._id;
    expect(upload.body.data.status).toBe('uploaded');
    const job: any = await Job.findOneAndUpdate({ kind: 'document', organizationId: account.organization._id }, { $set: { status: 'running', lockedBy: 'document-test', leaseUntil: new Date(Date.now() + env.JOB_LEASE_MS) }, $inc: { attempts: 1 } }, { new: true }).select('+payload');
    await processDocumentJob(job);
    const document: any = await KnowledgeDocument.findById(id).lean();
    expect(document.status).toBe('ready');
    expect(await KnowledgeChunk.countDocuments({ documentId: id, organizationId: account.organization._id })).toBeGreaterThan(0);
    expect((await buildKnowledgeSnapshot(String(account.organization._id))).chunks).toHaveLength(0);
    const publish = await request(app).post(`${root}/documents/${id}/publish`).set(account.headers).send({ version: document.version });
    expect(publish.status).toBe(200);
    expect((await buildKnowledgeSnapshot(String(account.organization._id))).chunks[0]?.text).toContain('approved claims');
    const download = await request(app).get(`${root}/documents/${id}/download`).set(account.headers);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['cache-control']).toContain('no-store');
    expect(await AuditEvent.countDocuments({ organizationId: account.organization._id, action: 'document.exported' })).toBe(1);
    const other = await verifiedUser('other@documents.test', 'Other docs');
    expect((await request(app).get(`${base(other.organization)}/documents/${id}/download`).set(other.headers)).status).toBe(404);
  });

  it('rejects forged media, malformed ZIPs, wrong extensions, and unexpected form fields', async () => {
    const account = await verifiedUser();
    const endpoint = `${base(account.organization)}/documents`;
    expect((await request(app).post(endpoint).set(account.headers).attach('file', Buffer.from('not a PDF'), { filename: 'forged.pdf', contentType: 'application/pdf' })).status).toBe(415);
    expect((await request(app).post(endpoint).set(account.headers).attach('file', docx(), { filename: 'document.exe', contentType: docxType })).status).toBe(415);
    expect((await request(app).post(endpoint).set(account.headers).attach('file', Buffer.from('PK\x03\x04broken'), { filename: 'broken.docx', contentType: docxType })).status).toBe(422);
    expect((await request(app).post(endpoint).set(account.headers).field('organizationId', 'a'.repeat(24)).attach('file', docx(), { filename: 'claims.docx', contentType: docxType })).status).toBe(400);
    expect(await KnowledgeDocument.countDocuments()).toBe(0);
  });

  it('enforces the multipart byte limit before storing any document', async () => {
    const account = await verifiedUser();
    const oversized = Buffer.alloc(env.MAX_UPLOAD_BYTES + 1);
    oversized.write('%PDF-1.4');
    const upload = await request(app).post(`${base(account.organization)}/documents`).set(account.headers).attach('file', oversized, { filename: 'large.pdf', contentType: 'application/pdf' });
    expect(upload.status).toBe(413);
    expect(await KnowledgeDocument.countDocuments()).toBe(0);
  });

  it('rejects unsafe DOCX packages and extracts text from a valid package', async () => {
    await expect(validateDocxArchive(zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<doc/>', 'word/vbaProject.bin': 'malicious macro' }))).rejects.toMatchObject({ code: 'UNSAFE_DOCX' });
    await expect(validateDocxArchive(zip({ 'not-a-document.txt': 'test' }))).rejects.toMatchObject({ code: 'INVALID_DOCX' });
    await expect(extractText(docx(), docxType)).resolves.toContain('approved claims require evidence');
  });

  it('requires processing before publication and bounds manual retries independently of automatic attempts', async () => {
    const account = await verifiedUser();
    const root = base(account.organization);
    const upload = await request(app).post(`${root}/documents`).set(account.headers).attach('file', docx(), { filename: 'claims.docx', contentType: docxType });
    const id = upload.body.data._id;
    expect((await request(app).post(`${root}/documents/${id}/publish`).set(account.headers).send({ version: 0 })).status).toBe(409);
    await KnowledgeDocument.updateOne({ _id: id }, { $set: { status: 'failed', attempts: 5, retryCount: 0 } });
    const retry = await request(app).post(`${root}/documents/${id}/retry`).set(account.headers).send({ version: 0 });
    expect(retry.status).toBe(202);
    expect(retry.body.data.retryCount).toBe(1);
    await KnowledgeDocument.updateOne({ _id: id }, { $set: { status: 'failed', retryCount: 3 } });
    expect((await request(app).post(`${root}/documents/${id}/retry`).set(account.headers).send({ version: 1 })).status).toBe(409);
  });
});
