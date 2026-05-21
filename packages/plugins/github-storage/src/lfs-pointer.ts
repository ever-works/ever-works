/**
 * EW-644 — Git LFS pointer file helpers.
 *
 * An LFS pointer is a tiny text file that is what actually lives in the
 * git tree. The bytes of the original file live on the LFS storage host
 * (for github.com, on `media.githubusercontent.com`) and are addressed
 * by `sha256:<digest>`.
 *
 * Spec: https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md
 *
 * Canonical 3-line shape:
 *   version https://git-lfs.github.com/spec/v1
 *   oid sha256:<lowercase-hex-sha256>
 *   size <bytes>
 *
 * Trailing newline required. Lines sorted lexically after the first
 * `version` line — for the standard `oid` + `size` pair that means
 * `oid` before `size`, alphabetical.
 */

const LFS_SPEC_URL = 'https://git-lfs.github.com/spec/v1';

export interface LfsPointer {
	readonly oid: string;
	readonly size: number;
}

/**
 * Render an LFS pointer file body. Always ends with a trailing newline,
 * which is required by the spec — without it `git lfs` rejects the
 * pointer as malformed.
 */
export function formatPointer(oid: string, size: number): string {
	if (!/^[0-9a-f]{64}$/.test(oid)) {
		throw new Error(`Invalid LFS oid (expected 64-char lowercase hex sha256): ${oid}`);
	}
	if (!Number.isInteger(size) || size < 0) {
		throw new Error(`Invalid LFS size (expected non-negative integer): ${size}`);
	}
	return `version ${LFS_SPEC_URL}\noid sha256:${oid}\nsize ${size}\n`;
}

/**
 * Parse an LFS pointer body back into `{oid, size}`. Returns `null` if
 * the content doesn't look like a pointer (so `getObject` can fall
 * through to the legacy direct-blob path when reading a non-LFS file).
 *
 * Tolerant of:
 *   - Trailing whitespace / extra newlines.
 *   - Extra `ext-*` lines (the spec allows them; we ignore them).
 *   - Either CR/LF or LF line endings.
 *
 * Strict on:
 *   - `version` line must reference an `https://git-lfs.github.com/spec/`
 *     URL. Rejects non-LFS files with a "version" first line.
 *   - `oid` must be `sha256:<64-hex>`.
 *   - `size` must be a non-negative integer.
 */
export function parsePointer(content: string): LfsPointer | null {
	if (content.length === 0 || content.length > 1024) return null;
	const lines = content
		.replace(/\r\n/g, '\n')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length < 3) return null;
	const version = lines[0];
	if (!version.startsWith('version https://git-lfs.github.com/spec/')) return null;
	let oid: string | undefined;
	let size: number | undefined;
	for (const line of lines.slice(1)) {
		const [key, value] = splitOnce(line, ' ');
		if (!key || !value) continue;
		if (key === 'oid') {
			const m = /^sha256:([0-9a-f]{64})$/.exec(value);
			if (!m) return null;
			oid = m[1];
		} else if (key === 'size') {
			const n = Number(value);
			if (!Number.isInteger(n) || n < 0) return null;
			size = n;
		}
	}
	if (oid === undefined || size === undefined) return null;
	return { oid, size };
}

/**
 * Build the `.gitattributes` line that tells LFS to track everything
 * under a given path prefix. The plugin keeps `.gitattributes` at the
 * repo root and appends this line idempotently — see `ensureGitattributes`
 * below.
 */
export function gitattributesLine(pathPrefix: string): string {
	const safe = pathPrefix.replace(/^\/+|\/+$/g, '');
	if (safe.length === 0) {
		// LFS-track the whole repo. Unusual but valid.
		return '* filter=lfs diff=lfs merge=lfs -text\n';
	}
	return `${safe}/** filter=lfs diff=lfs merge=lfs -text\n`;
}

/**
 * Return the new `.gitattributes` content with the line appended if it
 * isn't already present. Returns `null` if no change is needed — the
 * caller skips the commit entirely in that case (idempotent).
 */
export function ensureGitattributes(existing: string | null, pathPrefix: string): string | null {
	const line = gitattributesLine(pathPrefix).trimEnd();
	if (existing && existing.split(/\r?\n/).some((row) => row.trim() === line)) {
		return null;
	}
	const base = existing ?? '';
	const sep = base.length === 0 || base.endsWith('\n') ? '' : '\n';
	return `${base}${sep}${line}\n`;
}

function splitOnce(input: string, sep: string): [string | undefined, string | undefined] {
	const idx = input.indexOf(sep);
	if (idx < 0) return [input, undefined];
	return [input.slice(0, idx), input.slice(idx + sep.length)];
}
