# node-corepack

Note: this repository has been entirely produced by an AI (GPT-6-astra). I
really hoped to not have to do that repository, but node deciding to
remove corepack from its offcial images is a major PITA for my CIs,
so here we are.

Official Node 26 Alpine images, with the latest Corepack installed and enabled,
for **linux/amd64**. Published to `ghcr.io/<owner>/node-corepack`.

```dockerfile
FROM ghcr.io/<owner>/node-corepack:26-alpine
```

The image adds the equivalent of:

```dockerfile
FROM node:26-alpine
RUN npm install --global corepack@latest && corepack enable
```

The upstream entrypoint, command, user, and working directory are inherited.
Corepack's Yarn and pnpm shims are enabled; package managers are downloaded on
first use, following your project's `packageManager` setting.

## Tags

Only upstream Node 26 tags ending exactly in `-alpine` are mirrored, including
all available historical Node 26 releases:

| Example mirror tag | Upstream image |
| --- | --- |
| `26-alpine` | `node:26-alpine` |
| `26.8-alpine` | `node:26.8-alpine` |
| `26.8.2-alpine` | `node:26.8.2-alpine` |

The filter is `26[.minor[.patch]]-alpine`. Explicit Alpine versions such as
`26-alpine3.24`, bare tags such as `26`, global aliases such as `latest`,
`alpine`, and `lts-alpine`, other Node majors, Debian variants, and other
architectures are outside the mirror's scope.

## Set up publishing

1. Push this repository to GitHub and enable GitHub Actions. The sync runs on
   the default branch, daily at **05:23 UTC**, manually through **Actions → Sync
   images → Run workflow**, and when the image recipe or sync implementation
   changes on the default branch.
2. The workflow publishes to `ghcr.io/<repository-owner>/node-corepack`. It uses
   `GITHUB_TOKEN` with `packages: write`; no additional secrets are needed.
   The first run backfills all matching upstream tags, so it takes longer.
3. After the first publish, set the `node-corepack` package's visibility to
   **Public** if you want unauthenticated pulls. GHCR packages start private.
   If a package with this name already exists, give this repository Actions
   access in the package settings.

For a private package, authenticate your consuming CI to GHCR. The image's
`org.opencontainers.image.source` label links it to this repository.

GitHub schedules are best effort and can be delayed. In public repositories,
GitHub disables scheduled workflows after 60 days without repository activity;
re-enable the workflow if that happens. See GitHub's
[schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
and [GHCR documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## How synchronization works

Every run lists all matching tags through the paginated Docker Hub API and
reads each tag's **linux/amd64 manifest digest**. This catches new releases,
moving minor/major aliases, and upstream rebuilds of existing patch tags.
Changes to other architectures alone do not trigger builds. Tags whose amd64
image is still being published are reported and retried on the next run.

Corepack's npm `latest` version is resolved **once per run** and installed by
exact version. Each distinct combination of:

- upstream amd64 manifest digest;
- resolved Corepack version;
- Dockerfile contents and build recipe version;
- source repository label;

gets a `build-<sha256>` tag in GHCR. Tags sharing the same inputs reuse that one
image. Builds use a digest-pinned `FROM`, so upstream tag movement during the
build cannot change its contents.

Before publishing a new build, the workflow runs it with networking disabled
and checks Node 26, Alpine, amd64, the Corepack version, and all Yarn/pnpm
shims. It then pushes the build tag and updates only public-facing tags whose
manifest digest differs. An unchanged run performs **zero builds and zero tag
writes**. An alias can be added, repaired, or moved to an already built image
without rebuilding or transferring layers.

GHCR holds the synchronization state: there is no state branch, daily commit,
or dependency on an expiring Actions cache. Runs are serialized. A failed run
can be rerun; already published builds and updated tags are reused. Aliases
are updated individually, so a failed run can leave a partially updated set
until the next successful run. Authentication errors and incomplete API
responses fail the run instead of being treated as missing builds.

A **new Corepack release or Dockerfile change refreshes all matching images**,
including historical Node versions. Patch tags therefore remain mutable,
just like their upstream base images. Pin a published image digest when you
need fixed contents:

```dockerfile
FROM ghcr.io/<owner>/node-corepack@sha256:<digest>
```

Published images and build tags are retained, even if upstream removes a tag.
Deleting `build-*` tags loses reuse for those inputs and can cause rebuilds.
There is no automatic registry cleanup. If a future Corepack release no
longer supports an older Node 26 release, that build fails and its existing
tags remain available; the failed workflow needs attention.

## Local development

The synchronizer uses Node's standard library only: Node 24+ is required, with
no dependency install. Docker with Buildx is needed to build images.

```sh
npm test
npm run discover
```

Discovery is read-only, requires no credentials or Docker, and prints all
planned build groups and their tags. To compare against an existing public
GHCR package without building or publishing:

```sh
IMAGE=ghcr.io/<owner>/node-corepack npm run sync -- --dry-run
```

For a private or not-yet-created package, supply `REGISTRY_USERNAME` and
`REGISTRY_PASSWORD` (a token with the necessary package permissions). A local
publish also requires `docker login ghcr.io`, the same registry environment
variables, `IMAGE`, and `GITHUB_REPOSITORY=<owner>/<repo>` to match the workflow's
source label and build keys. Run `npm run sync` to publish.

To build just one image locally:

```sh
docker buildx build --load --platform linux/amd64 \
  --build-arg NODE_IMAGE=node:26-alpine \
  --build-arg COREPACK_VERSION=latest \
  --tag node-corepack:26-alpine .
docker run --rm node-corepack:26-alpine corepack --version
```

CI runs the unit tests and builds and smoke-tests a current image on pushes
and pull requests. Tests cover pagination, scope and architecture filtering,
build deduplication, moving tags, Corepack updates, recovery from partial
publishes, dry runs, and registry authentication/error handling. Actions are
pinned by commit; Dependabot checks for updates weekly. When changing build
flags or label semantics, bump `RECIPE_VERSION` in `scripts/sync.mjs`.

Upstream references: [Node Docker images](https://github.com/nodejs/docker-node),
[Corepack](https://github.com/nodejs/corepack), and the
[registry API](https://distribution.github.io/distribution/spec/api/).
