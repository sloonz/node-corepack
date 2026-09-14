import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from '../scripts/http.mjs';
import { Ghcr, sha256 } from '../scripts/registry.mjs';

const image = 'ghcr.io/example/node-corepack';
const digest = `sha256:${'a'.repeat(64)}`;

test('GHCR authenticates, scopes credentials, and reads manifest digests', async () => {
  const calls = [];
  const registry = new Ghcr(image, { username: 'user', password: 'secret', http: async (url, options) => {
    calls.push({ url: String(url), options });
    return calls.length === 1 ? Response.json({ token: 'bearer-token' })
      : new Response(null, { headers: { 'docker-content-digest': digest } });
  } });
  assert.equal(await registry.digest('26-alpine'), digest);
  assert.equal(new URL(calls[0].url).searchParams.get('scope'), 'repository:example/node-corepack:pull,push');
  assert.equal(calls[0].options.headers.Authorization, `Basic ${Buffer.from('user:secret').toString('base64')}`);
  assert.equal(calls[1].options.method, 'HEAD');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer bearer-token');
  assert.equal(calls[1].url, 'https://ghcr.io/v2/example/node-corepack/manifests/26-alpine');
});

test('only a manifest 404 means absent; permission, rate-limit, and server errors fail', async () => {
  for (const status of [404, 401, 403, 429, 500]) {
    const registry = new Ghcr(image, { http: async url => String(url).includes('/token')
      ? Response.json({ token: 'token' }) : new Response(null, { status }),
    });
    if (status === 404) assert.equal(await registry.digest('missing'), null);
    else await assert.rejects(registry.digest('missing'), new RegExp(String(status)));
  }
});

test('token errors are not mistaken for missing images', async () => {
  const registry = new Ghcr(image, { http: async () => new Response(null, { status: 403 }) });
  await assert.rejects(registry.digest('26-alpine'), /403/);
});

test('an expired token refreshes once and retries the request', async () => {
  let tokens = 0;
  const registry = new Ghcr(image, { http: async (url, options) => {
    if (String(url).includes('/token')) return Response.json({ token: `token-${++tokens}` });
    return options.headers.Authorization === 'Bearer token-1' ? new Response(null, { status: 401 })
      : new Response(null, { headers: { 'docker-content-digest': digest } });
  } });
  assert.equal(await registry.digest('26-alpine'), digest);
  assert.equal(tokens, 2);
});

test('retagging copies the exact verified manifest bytes and content type', async () => {
  const body = '{ "schemaVersion": 2, "layers": [] }';
  const expected = `sha256:${sha256(body)}`;
  let put;
  const registry = new Ghcr(image, { http: async (url, options) => {
    if (String(url).includes('/token')) return Response.json({ token: 'token' });
    if (options.method === 'PUT') {
      put = { url, options };
      return new Response(null, { status: 201, headers: { 'docker-content-digest': expected } });
    }
    return new Response(body, { headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json' } });
  } });
  const manifest = await registry.manifest(expected);
  await registry.tag('26-alpine', manifest);
  assert.equal(put.options.body.toString(), body);
  assert.equal(put.options.headers['Content-Type'], 'application/vnd.oci.image.manifest.v1+json');
  assert.ok(put.url.endsWith('/manifests/26-alpine'));
  await assert.rejects(registry.manifest(digest), /does not match/);
});

test('registry rejects invalid image names and incomplete credentials', () => {
  for (const value of ['docker.io/example/node', 'ghcr.io/UPPER/node', 'ghcr.io/example/node:26', 'ghcr.io/example/../node']) {
    assert.throws(() => new Ghcr(value));
  }
  assert.throws(() => new Ghcr(image, { password: 'secret' }));
});

test('HTTP retries transient failures and respects bounded Retry-After', async () => {
  const delays = [];
  let calls = 0;
  const response = await request('https://example.com', {}, {
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw new Error('network');
      if (calls === 2) return new Response(null, { status: 429, headers: { 'retry-after': '120' } });
      return new Response('ok');
    }, sleep: async value => delays.push(value),
  });
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(delays, [1000, 30_000]);
  let failures = 0;
  await assert.rejects(request('https://example.com', {}, {
    fetchImpl: async () => { failures++; return new Response(null, { status: 503 }); },
    sleep: async () => {},
  }), /503/);
  assert.equal(failures, 4);
});
