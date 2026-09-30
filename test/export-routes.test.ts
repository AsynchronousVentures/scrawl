// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { HttpProblem } from '../src/http/problems.js';

const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused@localhost/unused', API_DOCS_ENABLED: 'true' });
const id = '11111111-1111-4111-8111-111111111111';
const revisionId = '22222222-2222-4222-8222-222222222222';

test('export HTTP adapter preserves binary bytes, selected revision and generated OpenAPI media types', async (t) => {
  const binary = Buffer.from([0x50, 0x4b, 0, 0xff, 0x80, 0x0a]);
  let calls = 0;
  const app = await buildApp({ config, checkDatabase: async () => {}, logging: false, exporting: {
    async download(headers, documentId, format, selected) {
      calls++;
      assert.equal(documentId, id);
      assert.equal(selected, revisionId);
      assert.equal(headers.get('cookie'), 'synthetic-session=opaque-fixture');
      return { bytes: binary, filename: `synthetic.${format}`, mimeType: format === 'pdf'
        ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    },
  } });
  t.after(() => app.close());
  for (const format of ['pdf', 'docx']) {
    const response = await app.inject({ url: `/api/v1/documents/${id}/exports/${format}?revisionId=${revisionId}`,
      headers: { cookie: 'synthetic-session=opaque-fixture' } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, binary, 'Binary bytes must not pass through JSON serialization');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['content-disposition'], `attachment; filename="synthetic.${format}"`);
    assert.equal(response.headers.etag, undefined);
  }
  assert.equal(calls, 2);
  const description = (await app.inject('/openapi.json')).json();
  const operation = description.paths['/api/v1/documents/{id}/exports/{format}'].get;
  assert.equal(operation.operationId, 'exportDocumentFile');
  assert.deepEqual(Object.keys(operation.responses['200'].content).sort(), [
    'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]);
  for (const media of Object.values(operation.responses['200'].content) as { schema: { type: string; format: string } }[]) {
    assert.deepEqual(media.schema, { type: 'string', format: 'binary' });
  }
  for (const path of [`/api/v1/documents/not-a-uuid/exports/pdf`, `/api/v1/documents/${id}/exports/odt`,
    `/api/v1/documents/${id}/exports/pdf?revisionId=invalid`, `/api/v1/documents/${id}/exports/pdf?includeHistory=true`]) {
    const response = await app.inject(path);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'INVALID_REQUEST');
    assert.equal(response.headers['content-disposition'], undefined);
  }
  assert.equal(calls, 2, 'Malformed requests fail before invoking the capability');
});

test('export HTTP adapter returns sanitized failures without download headers or private bytes', async (t) => {
  const app = await buildApp({ config, checkDatabase: async () => {}, logging: false, exporting: {
    async download() { throw new HttpProblem(404, 'NOT_FOUND'); },
  } });
  t.after(() => app.close());
  const response = await app.inject(`/api/v1/documents/${id}/exports/pdf`);
  assert.equal(response.statusCode, 404);
  assert.equal(response.headers['content-disposition'], undefined);
  assert.equal(response.headers.etag, undefined);
  assert.match(String(response.headers['content-type']), /^application\/problem\+json/);
  assert.deepEqual(Object.keys(response.json()).sort(), ['code', 'requestId', 'status', 'title', 'type']);
});
