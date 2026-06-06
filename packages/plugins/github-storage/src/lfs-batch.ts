/**
 * EW-644 — GitHub LFS Batch API client.
 *
 * Implements the upload and download halves of the LFS Batch API as
 * specified at:
 *   https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md
 *
 * For github.com the endpoint is:
 *   POST https://github.com/<owner>/<repo>.git/info/lfs/objects/batch
 *
 * We talk to it directly with Node 22's global `fetch` — no octokit
 * wrapping is needed and it would be the wrong abstraction here (LFS
 * isn't part of the REST API). Authentication is `Bearer <token>` with
 * the same token the plugin uses for the Contents API; GitHub gates LFS
 * access by the same scopes (`contents:write` for upload, `contents:read`
 * for download).
 *
 * Error model: every helper returns a discriminated union rather than
 * throwing, because LFS-specific failures (object already exists, repo
 * has LFS disabled) are routine and the caller wants to handle them
 * differently from genuine network/HTTP errors. Network/HTTP failures
 * are returned as `kind: 'error'` with the upstream status code.
 */

export interface LfsBatchTarget {
	readonly owner: string;
	readonly repo: string;
	readonly token: string;
	/**
	 * EW-644 (Greptile P2 fix) — host base for the LFS Batch endpoint.
	 * Defaults to `https://github.com`. GitHub Enterprise Server
	 * deployments override this to e.g. `https://ghe.example.com` via
	 * the `GITHUB_STORAGE_API_HOST` env var (resolved by the plugin
	 * before calling `lfsBatch`). Keep just the scheme + host; the
	 * `/<owner>/<repo>.git/info/lfs/objects/batch` suffix is appended.
	 */
	readonly hostBase?: string;
}

const DEFAULT_LFS_HOST_BASE = 'https://github.com';

export interface LfsObjectIdentifier {
	readonly oid: string;
	readonly size: number;
}

export type LfsBatchOperation = 'upload' | 'download';

export interface LfsActionDescriptor {
	readonly href: string;
	readonly header?: Record<string, string>;
	readonly expiresAt?: string;
}

export type LfsBatchResult =
	| {
			readonly kind: 'action';
			readonly upload?: LfsActionDescriptor;
			readonly download?: LfsActionDescriptor;
			readonly verify?: LfsActionDescriptor;
	  }
	| {
			readonly kind: 'already-exists';
	  }
	| {
			readonly kind: 'error';
			readonly status: number;
			readonly message: string;
	  };

/**
 * Issue a single-object LFS batch request. The endpoint accepts an
 * array of objects; we keep the interface one-at-a-time because the
 * github-storage plugin uploads files one-by-one and batching N
 * concurrent uploads belongs in a future ticket.
 */
export async function lfsBatch(
	target: LfsBatchTarget,
	object: LfsObjectIdentifier,
	operation: LfsBatchOperation,
	fetchImpl: typeof fetch = fetch
): Promise<LfsBatchResult> {
	// Security (SSRF): `hostBase` is operator-controlled via the
	// `GITHUB_STORAGE_API_HOST` env var and is used verbatim as the
	// scheme+host the GitHub Bearer token is POSTed to. Without a scheme
	// guard a value like `http://169.254.169.254` would ship the token to
	// the cloud IMDS (or any plaintext host). Pin the transport to
	// `https://` — github.com and every legitimate GHE host already use
	// it, so this rejects only `http://`/`file://`/`gopher://`-style
	// SSRF targets and leaves valid hosts untouched.
	const hostBase = assertHttpsHostBase((target.hostBase || DEFAULT_LFS_HOST_BASE).replace(/\/$/, ''));
	const url = `${hostBase}/${encodePath(target.owner)}/${encodePath(target.repo)}.git/info/lfs/objects/batch`;
	const body = JSON.stringify({
		operation,
		transfers: ['basic'],
		objects: [{ oid: object.oid, size: object.size }]
	});
	const res = await fetchImpl(url, {
		method: 'POST',
		headers: {
			Accept: 'application/vnd.git-lfs+json',
			'Content-Type': 'application/vnd.git-lfs+json',
			Authorization: `Bearer ${target.token}`
		},
		body
	});
	if (!res.ok) {
		// Security (info-leak): pass the bearer token so it is stripped from
		// any upstream body before it lands in the returned error message.
		return { kind: 'error', status: res.status, message: await safeText(res, [target.token]) };
	}
	const payload = (await res.json()) as RawBatchResponse;
	const first = payload.objects?.[0];
	if (!first) {
		return { kind: 'error', status: 502, message: 'LFS batch returned no objects' };
	}
	if (first.error) {
		return { kind: 'error', status: first.error.code ?? 502, message: first.error.message };
	}
	const actions = first.actions;
	if (!actions || Object.keys(actions).length === 0) {
		return { kind: 'already-exists' };
	}
	return {
		kind: 'action',
		upload: actions.upload ? toDescriptor(actions.upload) : undefined,
		download: actions.download ? toDescriptor(actions.download) : undefined,
		verify: actions.verify ? toDescriptor(actions.verify) : undefined
	};
}

/**
 * Upload the blob to the signed URL returned by `lfsBatch`. The LFS
 * spec uses straight HTTP PUT with the blob as the body, plus whatever
 * headers the batch response specified (typically just `Authorization`
 * — github.com's signed URL is short-lived but uses bearer auth, not
 * AWS-style query-string signing).
 */
export async function lfsUpload(
	descriptor: LfsActionDescriptor,
	buffer: Buffer,
	fetchImpl: typeof fetch = fetch
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
	const res = await fetchImpl(descriptor.href, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/octet-stream',
			'Content-Length': String(buffer.length),
			...(descriptor.header ?? {})
		},
		// node-fetch accepts Buffer directly; for the global fetch we wrap
		// in a Uint8Array which is also accepted by undici as a Body.
		body: new Uint8Array(buffer) as unknown as BodyInit
	});
	if (!res.ok) {
		return { ok: false, status: res.status, message: await safeText(res) };
	}
	return { ok: true };
}

/**
 * Download the blob from the URL returned by `lfsBatch` with
 * `operation: download`. Returns the bytes; the caller is responsible
 * for resolving the MIME type (the github-storage plugin reuses
 * `guessMime` on the original filename — pointer files don't carry
 * one).
 */
export async function lfsDownload(
	descriptor: LfsActionDescriptor,
	fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; buffer: Buffer } | { ok: false; status: number; message: string }> {
	const res = await fetchImpl(descriptor.href, {
		method: 'GET',
		headers: { ...(descriptor.header ?? {}) }
	});
	if (!res.ok) {
		return { ok: false, status: res.status, message: await safeText(res) };
	}
	const arrayBuf = await res.arrayBuffer();
	return { ok: true, buffer: Buffer.from(arrayBuf) };
}

interface RawBatchResponse {
	objects?: RawBatchObject[];
}

interface RawBatchObject {
	oid: string;
	size: number;
	actions?: {
		upload?: RawAction;
		download?: RawAction;
		verify?: RawAction;
	};
	error?: { code?: number; message: string };
}

interface RawAction {
	href: string;
	header?: Record<string, string>;
	expires_at?: string;
}

function toDescriptor(raw: RawAction): LfsActionDescriptor {
	const descriptor: { href: string; header?: Record<string, string>; expiresAt?: string } = {
		href: raw.href
	};
	if (raw.header) descriptor.header = raw.header;
	if (raw.expires_at) descriptor.expiresAt = raw.expires_at;
	return descriptor as LfsActionDescriptor;
}

function encodePath(segment: string): string {
	return encodeURIComponent(segment);
}

/**
 * Security (SSRF): enforce that the LFS host base is an absolute
 * `https://` URL before any request (carrying the GitHub Bearer token)
 * is sent to it. Parsing with the URL constructor also rejects
 * scheme-less / malformed values up front. Returns the normalized
 * origin-prefixed base unchanged for legitimate `https://` hosts.
 */
function assertHttpsHostBase(hostBase: string): string {
	let parsed: URL;
	try {
		parsed = new URL(hostBase);
	} catch {
		throw new Error('LFS host base must be an absolute https:// URL');
	}
	if (parsed.protocol !== 'https:') {
		throw new Error('LFS host base must use the https:// scheme');
	}
	return hostBase;
}

async function safeText(res: Response, secrets: ReadonlyArray<string> = []): Promise<string> {
	try {
		return redactSecrets((await res.text()).slice(0, 1000), secrets);
	} catch {
		return res.statusText;
	}
}

/**
 * Security (info-leak): an LFS host (operator-controlled via
 * `GITHUB_STORAGE_API_HOST`, including self-hosted/GHE LFS servers) is
 * untrusted from a credential-handling standpoint. Its raw error body is
 * surfaced into thrown error messages and may be logged, so scrub any
 * credential material before it leaves this module: the exact bearer
 * token we sent, plus any `Authorization:`/`Bearer <...>` token a
 * misbehaving or proxy-fronted endpoint might echo back. Legitimate
 * diagnostics (e.g. "Git LFS is disabled") are preserved.
 */
function redactSecrets(text: string, secrets: ReadonlyArray<string>): string {
	let out = text;
	for (const secret of secrets) {
		if (secret && secret.length >= 4) {
			out = out.split(secret).join('[REDACTED]');
		}
	}
	return out
		.replace(/(authorization\s*:\s*)\S+/gi, '$1[REDACTED]')
		.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');
}
