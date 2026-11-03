// SPDX-License-Identifier: AGPL-3.0-only
// A file through a tenant's RAG API, as LibreChat sends one: upload, search, delete (P1-08).
// Runs on the tenant's own network. The embeddings go through the gateway, which records them.
import { createHmac, randomUUID } from 'node:crypto';

const { RAG_URL, RAG_JWT_SECRET } = process.env;
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** What LibreChat's generateShortLivedToken makes. */
function token() {
  const payload = { id: 'f'.repeat(24), exp: Math.floor(Date.now() / 1000) + 300 };
  const unsigned = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(payload)}`;
  const signature = createHmac('sha256', RAG_JWT_SECRET).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

async function call(path, init = {}) {
  const res = await fetch(`${RAG_URL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token()}`, ...init.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const fileId = randomUUID();
const form = new FormData();
form.append('file_id', fileId);
form.append(
  'file',
  new Blob(['Kurulum denemesi: Ankara şubesinin kira sözleşmesi.'], { type: 'text/plain' }),
  'smoke.txt',
);
const upload = await call('/embed', { method: 'POST', body: form });
if (upload.status !== true || upload.known_type !== true) {
  throw new Error(`upload refused: ${JSON.stringify(upload).slice(0, 200)}`);
}

const found = await call('/query', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ file_id: fileId, query: 'kira sözleşmesi', k: 1 }),
});
if (!found[0]?.[0]?.page_content?.includes('kira sözleşmesi')) {
  throw new Error(`search did not find the file: ${JSON.stringify(found).slice(0, 200)}`);
}

await call('/documents', {
  method: 'DELETE',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify([fileId]),
});
console.log('rag-smoke ok');
