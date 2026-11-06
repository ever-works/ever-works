#!/usr/bin/env node
/**
 * Uploads build outputs to our own S3 storage (MinIO, bucket `ci-artifacts`, objects expire after 14 days)
 * and prints a presigned download link for each file, valid 7 days (the SigV4 maximum).
 *
 * Why: GitHub's artifact storage for the org is full ("Artifact storage quota has been hit"), so
 * `actions/upload-artifact` fails. Workflows call this when the `CI_ARTIFACTS_S3_*` settings exist and keep
 * `actions/upload-artifact` for forks, which have none. Only the secret key should be a secret: runners mask secret
 * values in logs and summaries, and the bucket and key id are part of every link.
 *
 *   node scripts/ci/upload-ci-artifacts.mjs --self-test
 *   node scripts/ci/upload-ci-artifacts.mjs --prefix ever-works/desktop/<branch>/<sha>/<label> 'apps/desktop/release/*.deb' ...
 *
 * Environment:
 *   CI_ARTIFACTS_S3_ENDPOINT           http(s)://host[:port] used for the uploads (path-style requests)
 *   CI_ARTIFACTS_S3_BUCKET             bucket name
 *   CI_ARTIFACTS_S3_ACCESS_KEY_ID      a key that may put and get objects in that bucket
 *   CI_ARTIFACTS_S3_SECRET_ACCESS_KEY
 *   CI_ARTIFACTS_S3_REGION             optional, default us-east-1
 *   CI_ARTIFACTS_S3_DOWNLOAD_ENDPOINT  optional: the host the links point at, when people reach the store under
 *                                      another name than the build does. Default: CI_ARTIFACTS_S3_ENDPOINT
 *   GITHUB_STEP_SUMMARY                optional: the links are appended there as a table
 *
 * Patterns: a directory plus a file name with `*` and `?` (`apps/desktop/release/*.AppImage`), as the
 * workflows use them. The run fails when no pattern matches a file, like `if-no-files-found: error`, and
 * when any upload fails after retries: the upload is the point of the job. Each upload is checked against
 * the ETag the store returns (MD5 of the body for a single PUT).
 *
 * No dependencies: SigV4 query signing is a few HMACs, and the script must run before or without
 * `pnpm install`, in Git Bash on our Windows runners and in the in-cluster Linux runner.
 */
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, readdirSync, statSync, appendFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEVEN_DAYS = 7 * 24 * 60 * 60;
const ATTEMPTS = 4;

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it: everything but A-Z a-z 0-9 - _ . ~ is percent-encoded. */
export function uriEncode(value, keepSlash = false) {
	return Array.from(Buffer.from(String(value), 'utf8'))
		.map((b) => {
			const c = String.fromCharCode(b);
			if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === '/')) return c;
			return `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
		})
		.join('');
}

const amzDate = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * SigV4 query-string signature (a presigned URL) for one request. `host` is what the client sends in the
 * Host header (with the port when it is not the scheme's default); `canonicalPath` is already encoded.
 */
export function presignQuery({ method, host, canonicalPath, accessKeyId, secretAccessKey, region, expires, date }) {
	const stamp = amzDate(date);
	const day = stamp.slice(0, 8);
	const scope = `${day}/${region}/s3/aws4_request`;
	const params = {
		'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
		'X-Amz-Credential': `${accessKeyId}/${scope}`,
		'X-Amz-Date': stamp,
		'X-Amz-Expires': String(expires),
		'X-Amz-SignedHeaders': 'host'
	};
	const query = Object.keys(params)
		.sort()
		.map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`)
		.join('&');
	const canonicalRequest = [method, canonicalPath, query, `host:${host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
	const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256hex(canonicalRequest)].join('\n');
	let key = hmac(`AWS4${secretAccessKey}`, day);
	for (const part of [region, 's3', 'aws4_request']) key = hmac(key, part);
	const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
	return `${query}&X-Amz-Signature=${signature}`;
}

/** A presigned path-style URL for `bucket/key` on `endpoint`. */
export function presignUrl({ method, endpoint, bucket, key, accessKeyId, secretAccessKey, region, expires, date = new Date() }) {
	const base = new URL(endpoint);
	const prefix = base.pathname.replace(/\/+$/, '');
	const canonicalPath = `${prefix}/${uriEncode(bucket)}/${uriEncode(key, true)}`;
	const query = presignQuery({ method, host: base.host, canonicalPath, accessKeyId, secretAccessKey, region, expires, date });
	return `${base.protocol}//${base.host}${canonicalPath}?${query}`;
}

/** Files matching `dir/name-pattern`; only the last segment may hold `*` or `?`. */
export function expand(pattern) {
	const normalized = pattern.replace(/\\/g, '/');
	const dir = path.posix.dirname(normalized);
	const name = path.posix.basename(normalized);
	if (/[*?]/.test(dir)) throw new Error(`Only the file name may hold wildcards: ${pattern}`);
	if (!/[*?]/.test(name)) {
		try {
			return statSync(normalized).isFile() ? [normalized] : [];
		} catch {
			return [];
		}
	}
	const re = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
	let entries = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.isFile() && re.test(e.name))
		.map((e) => path.posix.join(dir, e.name))
		.sort();
}

function request(url, { method, headers = {}, body }) {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const lib = u.protocol === 'https:' ? https : http;
		const req = lib.request(u, { method, headers, timeout: 10 * 60 * 1000 }, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
			res.on('error', reject);
		});
		req.on('timeout', () => req.destroy(new Error('request timed out')));
		req.on('error', reject);
		if (body) body(req);
		else req.end();
	});
}

/** One PUT of the file; resolves with the MD5 and SHA-256 of what was sent and the store's ETag. */
async function putFile(url, file, size) {
	const md5 = createHash('md5');
	const sha = createHash('sha256');
	const res = await request(url, {
		method: 'PUT',
		headers: { 'Content-Length': String(size), 'Content-Type': 'application/octet-stream' },
		body: (req) => {
			const stream = createReadStream(file);
			stream.on('data', (c) => {
				md5.update(c);
				sha.update(c);
			});
			stream.on('error', (e) => req.destroy(e));
			stream.pipe(req);
		}
	});
	return { res, md5: md5.digest('hex'), sha256: sha.digest('hex') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function humanSize(bytes) {
	const units = ['B', 'KiB', 'MiB', 'GiB'];
	let v = bytes;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i += 1;
	}
	return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function config(env) {
	const need = ['CI_ARTIFACTS_S3_ENDPOINT', 'CI_ARTIFACTS_S3_BUCKET', 'CI_ARTIFACTS_S3_ACCESS_KEY_ID', 'CI_ARTIFACTS_S3_SECRET_ACCESS_KEY'];
	const missing = need.filter((n) => !env[n]);
	if (missing.length) throw new Error(`Missing ${missing.join(', ')}`);
	return {
		endpoint: env.CI_ARTIFACTS_S3_ENDPOINT,
		downloadEndpoint: env.CI_ARTIFACTS_S3_DOWNLOAD_ENDPOINT || env.CI_ARTIFACTS_S3_ENDPOINT,
		bucket: env.CI_ARTIFACTS_S3_BUCKET,
		accessKeyId: env.CI_ARTIFACTS_S3_ACCESS_KEY_ID,
		secretAccessKey: env.CI_ARTIFACTS_S3_SECRET_ACCESS_KEY,
		region: env.CI_ARTIFACTS_S3_REGION || 'us-east-1'
	};
}

async function upload(prefix, patterns, env) {
	const cfg = config(env);
	const files = [];
	for (const p of patterns) {
		const found = expand(p);
		if (!found.length) console.log(`::warning title=No files::Nothing matches ${p}`);
		for (const f of found) if (!files.includes(f)) files.push(f);
	}
	if (!files.length) throw new Error(`No files match ${patterns.join(', ')}`);

	const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '');
	const rows = [];
	for (const file of files) {
		const size = statSync(file).size;
		const key = `${cleanPrefix}/${path.posix.basename(file)}`;
		let done = null;
		for (let attempt = 1; attempt <= ATTEMPTS && !done; attempt += 1) {
			try {
				const url = presignUrl({ ...cfg, method: 'PUT', key, expires: 3600 });
				const { res, md5, sha256 } = await putFile(url, file, size);
				if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 300)}`);
				const etag = String(res.headers.etag || '').replace(/"/g, '');
				if (etag !== md5) throw new Error(`ETag ${etag || '(none)'} is not the MD5 of the file (${md5})`);
				done = { sha256 };
			} catch (e) {
				console.log(`  ${file}: attempt ${attempt} of ${ATTEMPTS} failed: ${e.message}`);
				if (attempt < ATTEMPTS) await sleep(5000 * attempt);
			}
		}
		if (!done) throw new Error(`Upload of ${file} failed ${ATTEMPTS} times`);
		const link = presignUrl({ ...cfg, endpoint: cfg.downloadEndpoint, method: 'GET', key, expires: SEVEN_DAYS });
		console.log(`uploaded s3://${cfg.bucket}/${key} (${humanSize(size)}, sha256 ${done.sha256})`);
		console.log(`  ${link}`);
		rows.push({ name: path.posix.basename(file), size, sha256: done.sha256, key, link });
	}

	if (env.GITHUB_STEP_SUMMARY) {
		const until = new Date(Date.now() + SEVEN_DAYS * 1000).toISOString().slice(0, 16).replace('T', ' ');
		const lines = [
			`### Installers: s3://${cfg.bucket}/${cleanPrefix}/`,
			'',
			`Links work until ${until} UTC; the files are deleted after 14 days.`,
			'',
			'| File | Size | SHA-256 |',
			'|---|---|---|',
			...rows.map((r) => `| [${r.name}](${r.link}) | ${humanSize(r.size)} | \`${r.sha256}\` |`),
			''
		];
		appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
	}
	return rows;
}

/** The presigned GET example of AWS's S3 SigV4 documentation, plus the controls of this script's own parts. */
function selfTest() {
	const failures = [];
	const check = (name, actual, expected) => {
		if (actual !== expected) failures.push(`${name}: expected ${expected}, got ${actual}`);
	};
	const aws = presignQuery({
		method: 'GET',
		host: 'examplebucket.s3.amazonaws.com',
		canonicalPath: '/test.txt',
		accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
		secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
		region: 'us-east-1',
		expires: 86400,
		date: new Date('2013-05-24T00:00:00Z')
	});
	check('AWS documentation signature', aws.split('X-Amz-Signature=')[1], 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
	check('credential encoding', /X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&/.test(aws), true);
	check('key encoding', uriEncode('ever-works/desktop/feat/x y+z/a.exe', true), 'ever-works/desktop/feat/x%20y%2Bz/a.exe');
	const url = presignUrl({
		method: 'GET',
		endpoint: 'http://192.168.1.181:9000',
		bucket: 'ci-artifacts',
		key: 'a/b.deb',
		accessKeyId: 'k',
		secretAccessKey: 's',
		region: 'us-east-1',
		expires: SEVEN_DAYS,
		date: new Date('2026-11-06T00:00:00Z')
	});
	check('path-style URL', url.startsWith('http://192.168.1.181:9000/ci-artifacts/a/b.deb?X-Amz-Algorithm='), true);
	check('seven days', /X-Amz-Expires=604800&/.test(url), true);
	if (failures.length) {
		for (const f of failures) console.error(`self-test: ${f}`);
		return 1;
	}
	console.log('self-test: ok');
	return 0;
}

async function main(argv) {
	if (argv.includes('--self-test')) return selfTest();
	const i = argv.indexOf('--prefix');
	if (i < 0 || !argv[i + 1]) {
		console.error('usage: upload-ci-artifacts.mjs --prefix <key prefix> <pattern>... | --self-test');
		return 2;
	}
	const prefix = argv[i + 1];
	const patterns = argv.filter((_, j) => j !== i && j !== i + 1).filter((a) => a.trim() !== '');
	try {
		await upload(prefix, patterns, process.env);
		return 0;
	} catch (e) {
		console.log(`::error title=Installer upload failed::${e.message}`);
		return 1;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main(process.argv.slice(2));
}
