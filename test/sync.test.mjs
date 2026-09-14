import assert from 'node:assert/strict';
import test from 'node:test';
import { buildImage, discover, groupBuilds, latestCorepack, synchronize } from '../scripts/sync.mjs';

const digest = letter => `sha256:${letter.repeat(64)}`;
const a = digest('a');
const b = digest('b');
const c = digest('c');
const amd64 = value => ({ os: 'linux', architecture: 'amd64', digest: value });
const tag = (name, value = a) => ({ name, images: [amd64(value)] });
const options = { corepackVersion: '0.36.0', dockerfile: 'FROM node', source: 'https://github.com/example/node-corepack' };
const builds = () => groupBuilds(new Map([
  ['26-alpine', a], ['26.8-alpine', a], ['26.8.2-alpine', a],
  ['26.7-alpine', b], ['26.7.0-alpine', b],
]), options);

class FakeRegistry {
  image = 'ghcr.io/example/node-corepack';
  tags = new Map();
  writes = [];
  async digest(tag) { return this.tags.get(tag) ?? null; }
  async manifest(digest) { return { digest }; }
  async tag(tag, manifest) {
    this.tags.set(tag, manifest.digest);
    this.writes.push(tag);
  }
}

test('discovery follows all pages, filters exact scope, and selects amd64 child digests', async () => {
  const next = 'https://hub.docker.com/v2/namespaces/library/repositories/node/tags?page=2';
  const pages = [
    { results: [tag('26-alpine'), tag('24-alpine'), tag('25-alpine'), tag('126-alpine'),
      tag('26'), tag('26-slim'), tag('26-alpine3.24-extra'), tag('26.8.2.1-alpine'),
      tag('26-alpine3.24'), tag('26.8-alpine3.24'), tag('26.8.2-alpine3.24'),
      tag('26.8.2-alpine')], next },
    { results: [{ name: '26.8-alpine', digest: c, images: [
      { os: 'linux', architecture: 'arm64', digest: c },
      { os: 'unknown', architecture: 'unknown', digest: c }, amd64(b),
    ] }, { name: '26.9-alpine', images: [] }], next: null },
  ];
  const seen = [];
  const warnings = [];
  const result = await discover({
    http: async url => { seen.push(url); return Response.json(pages.shift()); },
    warn: message => warnings.push(message),
  });
  assert.equal(seen[1], next);
  assert.deepEqual([...result.tags], [['26-alpine', a], ['26.8.2-alpine', a], ['26.8-alpine', b]]);
  assert.deepEqual(result.pending, ['26.9-alpine']);
  assert.equal(warnings.length, 1);
});

test('discovery fails on empty results, bad pagination, conflicting tags, or malformed digests', async () => {
  for (const page of [
    { results: [], next: null },
    { results: [tag('26-alpine')], next: 'https://example.com/tags' },
    { results: [tag('26-alpine', 'not-a-digest')], next: null },
    { results: [tag('26-alpine'), tag('26-alpine', b)], next: null },
    { results: [{ name: '26-alpine', images: [amd64(a), amd64(b)] }], next: null },
    { results: [{ name: '26-alpine' }], next: null },
  ]) {
    await assert.rejects(discover({ http: async () => Response.json(page) }));
  }
});

test('a failed later discovery page does not yield a partial snapshot', async () => {
  let count = 0;
  await assert.rejects(discover({ http: async () => ++count === 1
    ? Response.json({ results: [tag('26-alpine')], next: 'https://hub.docker.com/v2/namespaces/library/repositories/node/tags?page=2' })
    : new Response(null, { status: 503 }),
  }), /503/);
});

test('Corepack latest resolves to an exact stable version', async () => {
  assert.equal(await latestCorepack(async () => Response.json({ version: '0.36.0' })), '0.36.0');
  await assert.rejects(latestCorepack(async () => Response.json({ version: 'latest' })));
});

test('aliases share a build; base, Corepack, recipe, and source changes invalidate it', () => {
  const groups = builds();
  assert.equal(groups.length, 2);
  assert.equal(groups.find(group => group.baseDigest === a).tags.length, 3);
  const tags = new Map([['26-alpine', a]]);
  const original = groupBuilds(tags, options)[0].cacheTag;
  for (const change of [
    { corepackVersion: '0.37.0' }, { dockerfile: 'FROM changed' }, { source: 'https://github.com/new/repo' },
  ]) assert.notEqual(groupBuilds(tags, { ...options, ...change })[0].cacheTag, original);
  assert.notEqual(groupBuilds(new Map([['26-alpine', b]]), options)[0].cacheTag, original);
  assert.equal(groupBuilds(new Map([['26.8-alpine', a]]), options)[0].cacheTag, original);
});

test('first sync builds once per digest; second sync performs zero writes or builds', async () => {
  const registry = new FakeRegistry();
  const built = [];
  const config = { registry, log() {}, build: async group => {
    built.push(group.cacheTag);
    registry.tags.set(group.cacheTag, group.baseDigest === a ? b : c);
  } };
  assert.deepEqual(await synchronize(builds(), config), { builds: 2, updatedTags: 5, unchangedTags: 0 });
  registry.writes = [];
  assert.deepEqual(await synchronize(builds(), config), { builds: 0, updatedTags: 0, unchangedTags: 5 });
  assert.equal(built.length, 2);
  assert.deepEqual(registry.writes, []);
});

test('moving aliases and missing tags are repaired without rebuilding an existing image', async () => {
  const registry = new FakeRegistry();
  const [group] = groupBuilds(new Map([['26-alpine', a], ['26.8-alpine', a], ['26.8.2-alpine', a]]), options);
  registry.tags.set(group.cacheTag, c);
  registry.tags.set('26-alpine', b);
  registry.tags.set('26.8.2-alpine', c);
  assert.deepEqual(await synchronize([group], { registry, log() {}, build() { assert.fail('must not rebuild'); } }),
    { builds: 0, updatedTags: 2, unchangedTags: 1 });
  assert.equal(registry.tags.get('26-alpine'), c);
  assert.equal(registry.tags.get('26.8-alpine'), c);
});

test('Corepack updates rebuild historical tags as well as moving aliases', async () => {
  const registry = new FakeRegistry();
  const tags = new Map([['26-alpine', a], ['26.0.0-alpine', b]]);
  const config = { registry, log() {}, build: async group => registry.tags.set(group.cacheTag, c) };
  await synchronize(groupBuilds(tags, options), config);
  const summary = await synchronize(groupBuilds(tags, { ...options, corepackVersion: '0.37.0' }), config);
  assert.equal(summary.builds, 2);
});

test('a new source digest rebuilds only affected tags', async () => {
  const registry = new FakeRegistry();
  const tags = new Map([['26-alpine', a], ['26.0.0-alpine', b]]);
  const config = { registry, log() {}, build: async group => registry.tags.set(group.cacheTag, group.baseDigest) };
  await synchronize(groupBuilds(tags, options), config);
  tags.set('26-alpine', c);
  assert.deepEqual(await synchronize(groupBuilds(tags, options), config), { builds: 1, updatedTags: 1, unchangedTags: 1 });
});

test('dry run does not invoke builds or change the registry', async () => {
  const registry = new FakeRegistry();
  const result = await synchronize(builds(), { registry, dryRun: true, log() {}, build() { assert.fail(); } });
  assert.deepEqual(result, { builds: 2, updatedTags: 5, unchangedTags: 0 });
  assert.equal(registry.tags.size, 0);
});

test('failed build never advances public tags', async () => {
  const registry = new FakeRegistry();
  registry.tags.set('26-alpine', b);
  await assert.rejects(synchronize(builds(), { registry, log() {}, build() { throw new Error('smoke failed'); } }), /smoke failed/);
  assert.deepEqual([...registry.tags], [['26-alpine', b]]);
});

test('partial publication resumes from cached build and only repairs remaining tags', async () => {
  const registry = new FakeRegistry();
  const [group] = groupBuilds(new Map([['26-alpine', a], ['26.8-alpine', a]]), options);
  let built = 0;
  const config = { registry, log() {}, build: async group => { built++; registry.tags.set(group.cacheTag, c); } };
  const originalTag = registry.tag.bind(registry);
  registry.tag = async (tag, manifest) => {
    if (registry.writes.length === 1) throw new Error('interrupted');
    await originalTag(tag, manifest);
  };
  await assert.rejects(synchronize([group], config), /interrupted/);
  registry.tag = originalTag;
  assert.deepEqual(await synchronize([group], config), { builds: 0, updatedTags: 1, unchangedTags: 1 });
  assert.equal(built, 1);
});

test('registry read errors abort instead of triggering builds', async () => {
  const registry = new FakeRegistry();
  registry.digest = async () => { throw new Error('unauthorized'); };
  await assert.rejects(synchronize(builds(), { registry, log() {}, build() { assert.fail(); } }), /unauthorized/);
});

test('build pins source and Corepack, targets amd64, and tests before pushing', () => {
  const calls = [];
  const [group] = builds();
  buildImage(group, 'ghcr.io/example/node-corepack', args => calls.push(args));
  assert.ok(calls[0].includes(`NODE_IMAGE=docker.io/library/node@${group.baseDigest}`));
  assert.ok(calls[0].includes('COREPACK_VERSION=0.36.0'));
  assert.ok(calls[0].includes('linux/amd64'));
  assert.equal(calls[1][0], 'run');
  assert.ok(calls[1].includes('--network=none'));
  assert.equal(calls[2][0], 'push');
  const failedCalls = [];
  assert.throws(() => buildImage(group, 'ghcr.io/example/node-corepack', args => {
    failedCalls.push(args[0]);
    if (args[0] === 'run') throw new Error('smoke failed');
  }), /smoke failed/);
  assert.deepEqual(failedCalls, ['buildx', 'run']);
});
