import { createHash } from 'node:crypto';
import { HttpError, request } from './http.mjs';

const ACCEPT = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ');

export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function assertDigest(digest) {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) {
    throw new Error(`Invalid image digest: ${digest}`);
  }
  return digest;
}

export class Ghcr {
  constructor(image, { username, password, http = request } = {}) {
    if (!/^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/.test(image)) {
      throw new Error('IMAGE must be a lowercase ghcr.io/<owner>/<image> without a tag');
    }
    if (Boolean(username) !== Boolean(password)) {
      throw new Error('Provide both REGISTRY_USERNAME and REGISTRY_PASSWORD');
    }
    this.image = image;
    this.repository = image.slice('ghcr.io/'.length);
    this.username = username;
    this.password = password;
    this.http = http;
  }

  async authenticate() {
    const url = new URL('https://ghcr.io/token');
    url.searchParams.set('service', 'ghcr.io');
    // Request push too when authenticated, including for the very first publish.
    url.searchParams.set('scope', `repository:${this.repository}:${this.password ? 'pull,push' : 'pull'}`);
    const headers = this.password ? {
      Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
    } : {};
    const response = await this.http(url, { headers });
    if (!response.ok) throw new HttpError(url, response.status);
    const data = await response.json();
    this.token = data.token ?? data.access_token;
    if (!this.token) throw new Error('GHCR returned no registry token');
  }

  async manifestRequest(reference, options = {}) {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,127}$/.test(reference)) {
      throw new Error(`Invalid manifest reference: ${reference}`);
    }
    const url = `https://ghcr.io/v2/${this.repository}/manifests/${reference}`;
    if (!this.token) await this.authenticate();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.http(url, {
        ...options,
        headers: { Accept: ACCEPT, ...options.headers, Authorization: `Bearer ${this.token}` },
      });
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        await this.authenticate();
        continue;
      }
      if (response.status === 404 && options.method !== 'PUT') return null;
      if (!response.ok) throw new HttpError(url, response.status);
      return response;
    }
  }

  async digest(tag) {
    const response = await this.manifestRequest(tag, { method: 'HEAD' });
    return response ? assertDigest(response.headers.get('docker-content-digest')) : null;
  }

  async manifest(reference) {
    const response = await this.manifestRequest(reference);
    if (!response) throw new Error(`Missing published manifest: ${this.image}@${reference}`);
    const body = Buffer.from(await response.arrayBuffer());
    const digest = `sha256:${sha256(body)}`;
    if (reference.startsWith('sha256:') && digest !== reference) {
      throw new Error(`Manifest content does not match ${reference}`);
    }
    const contentType = response.headers.get('content-type')?.split(';')[0];
    if (!ACCEPT.split(', ').includes(contentType)) throw new Error('Unsupported manifest type');
    return { body, digest, contentType };
  }

  async tag(tag, manifest) {
    const response = await this.manifestRequest(tag, {
      method: 'PUT', body: manifest.body,
      headers: { 'Content-Type': manifest.contentType },
    });
    const digest = assertDigest(response.headers.get('docker-content-digest'));
    if (digest !== manifest.digest) throw new Error(`GHCR changed manifest digest for ${tag}`);
  }
}
