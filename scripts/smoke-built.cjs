// Exercise compiled CommonJS output over real HTTP and an ephemeral replica set.
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');

function pdfFixture() {
  const stream = 'BT /F1 12 Tf 50 700 Td (Compiled parser check.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let output = '%PDF-1.4\n';
  const offsets = [];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

Object.assign(process.env, {
  NODE_ENV: 'test', LOG_LEVEL: 'silent', RUN_WORKER: 'false',
  JWT_SECRET: 'compiled-smoke-only-abcdefghijklmnopqrstuvwxyz-0123456789-abcdef',
  AI_SERVICE_TOKEN: 'compiled-smoke-ai-only-abcdefghijklmnopqrstuvwxyz',
  COOKIE_SECURE: 'false', RATE_LIMIT_MAX: '1000', AUTH_RATE_LIMIT_MAX: '1000',
});

async function main() {
  let replica, server;
  let checks = 0;
  try {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.24' } });
    process.env.MONGODB_URI = replica.getUri('compiled_smoke');
    await require('../dist/config/database').connectDatabase();
    const { app } = require('../dist/app');
    const { Job } = require('../dist/models');
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, status, body, token) => {
      const response = await fetch(base + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, status, `${method} ${path} response`);
      checks++;
      return status === 204 ? undefined : response.json();
    };
    await call('GET', '/health', 200);
    await call('GET', '/ready', 200);
    const credentials = { email: 'compiled-smoke@example.test', password: 'Compiled-Smoke-Password-123!' };
    await call('POST', '/api/v1/auth/register', 201, { ...credentials, name: 'Compiled Smoke' });
    const email = await Job.findOne({ kind: 'email' }).select('+payload');
    const token = email.payload.text.match(/token=([a-f0-9]{64})/)[1];
    await call('POST', '/api/v1/auth/verify-email', 200, { token });
    const login = await call('POST', '/api/v1/auth/login', 200, credentials);
    const accessToken = login.data.accessToken;
    await call('GET', '/api/v1/auth/me', 200, undefined, accessToken);
    const organization = await call('POST', '/api/v1/organizations', 201, { name: 'Compiled Smoke', slug: 'compiled-smoke' }, accessToken);
    const root = `/api/v1/organizations/${organization.data._id}`;
    const content = await call('POST', `${root}/content`, 201, { title: 'Compiled draft', body: 'Original content.' }, accessToken);
    await call('PATCH', `${root}/content/${content.data._id}`, 200, { version: 0, body: 'Revised content.' }, accessToken);
    const history = await call('GET', `${root}/content/${content.data._id}/revisions`, 200, undefined, accessToken);
    assert.equal(history.data.length, 2);
    const text = await require('../dist/integrations/storage/extract').extractText(pdfFixture(), 'application/pdf');
    assert.ok(text.includes('Compiled parser check.'));
    await call('GET', `${root}/analytics`, 200, undefined, accessToken);
    await call('POST', '/api/v1/auth/logout', 204, undefined, accessToken);
    await call('GET', '/api/v1/auth/me', 401, undefined, accessToken);
    process.stdout.write(JSON.stringify({ compiledSmoke: 'passed', httpChecks: checks, compiledPdfParser: 'passed' }) + '\n');
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await mongoose.disconnect();
    await replica?.stop();
  }
}
main().catch(() => { process.stderr.write('Compiled backend smoke verification failed.\n'); process.exitCode = 1; });
