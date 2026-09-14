import { spawnSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { json, request } from './http.mjs';
import { assertDigest, Ghcr, sha256 } from './registry.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TAG_PATTERN = /^26(?:\.\d+){0,2}-alpine$/;
const HUB_TAGS = 'https://hub.docker.com/v2/namespaces/library/repositories/node/tags';
export const PLATFORM = 'linux/amd64';

// Change this when build flags or image metadata change. Dockerfile changes
// invalidate builds automatically; documentation and scheduler edits do not.
export const RECIPE_VERSION = '1';

export async function discover({ http = request, warn = console.warn } = {}) {
  let url = `${HUB_TAGS}?page_size=100&name=26`;
  const pages = new Set();
  const tags = new Map();
  const pending = new Set();
  while (url) {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://hub.docker.com' || parsed.pathname !== new URL(HUB_TAGS).pathname || pages.has(url)) {
      throw new Error('Invalid or repeated Docker Hub pagination URL');
    }
    pages.add(url);
    const data = await json(url, http);
    if (!Array.isArray(data.results) || !(data.next === null || typeof data.next === 'string')) {
      throw new Error('Invalid Docker Hub tags response');
    }
    for (const tag of data.results) {
      if (!TAG_PATTERN.test(tag.name)) continue;
      if (!Array.isArray(tag.images)) throw new Error(`Missing image metadata for ${tag.name}`);
      const images = tag.images.filter(image => image.os === 'linux' && image.architecture === 'amd64');
      if (images.length === 0) {
        pending.add(tag.name);
        warn(`Waiting for upstream linux/amd64 image: ${tag.name}`);
        continue;
      }
      const digests = new Set(images.map(image => assertDigest(image.digest)));
      if (digests.size !== 1) throw new Error(`Ambiguous amd64 image for ${tag.name}`);
      const [digest] = digests;
      if (tags.has(tag.name) && tags.get(tag.name) !== digest) {
        throw new Error(`Upstream changed during pagination: ${tag.name}; retry the sync`);
      }
      tags.set(tag.name, digest);
    }
    url = data.next;
  }
  if (tags.size === 0) throw new Error('No Node 26 Alpine amd64 tags found');
  return { tags, pending: [...pending].filter(tag => !tags.has(tag)) };
}

export async function latestCorepack(http = request) {
  const { version } = await json('https://registry.npmjs.org/corepack/latest', http);
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Invalid Corepack latest version');
  return version;
}

export function groupBuilds(tags, { corepackVersion, dockerfile, source }) {
  const groups = new Map();
  for (const [tag, baseDigest] of [...tags].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))) {
    if (!TAG_PATTERN.test(tag)) throw new Error(`Unsupported source tag: ${tag}`);
    assertDigest(baseDigest);
    if (!groups.has(baseDigest)) {
      const key = sha256(JSON.stringify({
        baseDigest, corepackVersion, dockerfile, source,
        platform: PLATFORM, recipeVersion: RECIPE_VERSION,
      }));
      groups.set(baseDigest, { baseDigest, corepackVersion, source, cacheTag: `build-${key}`, tags: [] });
    }
    groups.get(baseDigest).tags.push(tag);
  }
  return [...groups.values()];
}

export function runDocker(args) {
  const result = spawnSync('docker', args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed (${result.status ?? result.signal})`);
}

// Check Corepack and its shims without downloading Yarn or pnpm. Preserve and
// exercise the upstream entrypoint and default user as part of the check.
export function smokeTest(image, corepackVersion, run = runDocker) {
  run(['run', '--rm', '--network=none', '--platform', PLATFORM, image, 'sh', '-ec', `
    test -f /etc/alpine-release
    node -e 'if (process.platform !== "linux" || process.arch !== "x64" || !process.versions.node.startsWith("26.")) process.exit(1)'
    test "$(corepack --version)" = "$1"
    for shim in yarn yarnpkg pnpm pnpx; do
      target=$(readlink -f "$(command -v "$shim")")
      case "$target" in /usr/local/lib/node_modules/corepack/dist/*) ;; *) exit 1 ;; esac
    done
  `, 'smoke-test', corepackVersion]);
}

export function buildImage(group, image, run = runDocker) {
  const reference = `${image}:${group.cacheTag}`;
  run(['buildx', 'build', '--platform', PLATFORM, '--load', '--provenance=false', '--sbom=false',
    '--build-arg', `NODE_IMAGE=docker.io/library/node@${group.baseDigest}`,
    '--build-arg', `COREPACK_VERSION=${group.corepackVersion}`,
    '--label', `org.opencontainers.image.source=${group.source}`,
    '--label', 'org.opencontainers.image.description=Node 26 Alpine with Corepack enabled (linux/amd64)',
    '--label', `org.opencontainers.image.base.name=docker.io/library/node@${group.baseDigest}`,
    '--label', `org.opencontainers.image.base.digest=${group.baseDigest}`,
    '--label', `io.node-corepack.corepack.version=${group.corepackVersion}`,
    '--tag', reference, '.']);
  smokeTest(reference, group.corepackVersion, run);
  run(['push', reference]);
  // These locally loaded images are disposable; the registry retains the build.
  run(['image', 'rm', reference]);
}

export async function synchronize(groups, {
  registry, dryRun = false, build = buildImage, log = console.log,
}) {
  const summary = { builds: 0, updatedTags: 0, unchangedTags: 0 };
  for (const group of groups) {
    let digest = await registry.digest(group.cacheTag);
    if (!digest) {
      log(`${dryRun ? 'Would build' : 'Build'} ${group.cacheTag}: ${group.tags.join(', ')}`);
      summary.builds++;
      if (!dryRun) {
        await build(group, registry.image);
        digest = await registry.digest(group.cacheTag);
        if (!digest) throw new Error(`Build was not published: ${group.cacheTag}`);
      }
    }
    let manifest;
    for (const tag of group.tags) {
      const current = await registry.digest(tag);
      if (digest && current === digest) {
        summary.unchangedTags++;
        continue;
      }
      log(`${dryRun ? 'Would update' : 'Update'} ${registry.image}:${tag}`);
      if (!dryRun) {
        manifest ??= await registry.manifest(digest);
        await registry.tag(tag, manifest);
      }
      summary.updatedTags++;
    }
  }
  return summary;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args, options: {
    discover: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    smoke: { type: 'boolean', default: false },
  } });
  if (values.smoke) {
    if (!env.IMAGE || !env.COREPACK_VERSION) throw new Error('Smoke test requires IMAGE and COREPACK_VERSION');
    smokeTest(env.IMAGE, env.COREPACK_VERSION);
    return;
  }
  const [{ tags, pending }, corepackVersion, dockerfile] = await Promise.all([
    discover(), latestCorepack(), readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
  ]);
  const source = env.GITHUB_REPOSITORY ? `https://github.com/${env.GITHUB_REPOSITORY}` : '';
  const groups = groupBuilds(tags, { corepackVersion, dockerfile, source });
  console.log(`${tags.size} tags, ${groups.length} distinct amd64 images, Corepack ${corepackVersion}`);
  if (values.discover) {
    console.log(JSON.stringify({ corepackVersion, pending, groups }, null, 2));
    return;
  }
  const image = env.IMAGE || (env.GITHUB_REPOSITORY_OWNER
    ? `ghcr.io/${env.GITHUB_REPOSITORY_OWNER.toLowerCase()}/node-corepack` : '');
  const registry = new Ghcr(image, {
    username: env.REGISTRY_USERNAME, password: env.REGISTRY_PASSWORD,
  });
  if (!values['dry-run'] && !registry.password) throw new Error('Publishing requires registry credentials');
  const summary = await synchronize(groups, { registry, dryRun: values['dry-run'] });
  const report = `${values['dry-run'] ? 'Dry run: ' : ''}${summary.builds} builds, ${summary.updatedTags} tags updated, ${summary.unchangedTags} unchanged, ${pending.length} awaiting upstream amd64.`;
  console.log(report);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${report}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
