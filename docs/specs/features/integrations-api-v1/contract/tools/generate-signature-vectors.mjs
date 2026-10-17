// Generates ../webhook-signature-vectors.json (contract v1, B.5).
// Usage: node docs/specs/features/integrations-api-v1/contract/tools/generate-signature-vectors.mjs
// Deterministic: the secrets, timestamp and bodies are fixed, so a re-run is byte-identical unless the
// examples it reads (examples/events/task.updated.json, task.comment.created.json) change.
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const contractDir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const hmac = (key, payload) => createHmac('sha256', key).update(payload, 'utf8').digest('hex');

const SECRET = 'q3Vb8nZr0yX5kP2mW7tH4cJ9sL1eD6fA0gB3hN8uQ5w';
const PREVIOUS_SECRET = 'Zx7Lm2Qp9Rt4Vw1Ys6Ab3Cd8Ef5Gh0Ij2Kl7Mn4Op9Q';
const T = Date.UTC(2026, 9, 15, 18, 0, 0) / 1000; // 2026-10-15T18:00:00Z
const TOL = 300;

// The raw body exactly as Ever Works sends it: compact JSON of the envelope.
const envelope = JSON.parse(readFileSync(join(contractDir, 'examples/events/task.updated.json'), 'utf8'));
const BODY = JSON.stringify(envelope);
const UNICODE_BODY = JSON.stringify({
	...JSON.parse(readFileSync(join(contractDir, 'examples/events/task.comment.created.json'), 'utf8')),
	data: {
		...JSON.parse(readFileSync(join(contractDir, 'examples/events/task.comment.created.json'), 'utf8')).data,
		body: 'Готово — PR відкрито 🚀 (Ünïcødé, 商品, ₴199)'
	}
});

const sign = (secret, t, body) => hmac(secret, `${t}.${body}`);
const header = (t, ...sigs) => `t=${t},${sigs.map((s) => `v1=${s}`).join(',')}`;

let v = [];
const add = (o) => v.push({ toleranceSeconds: TOL, ...o });

const good = sign(SECRET, T, BODY);
add({
	name: 'valid-basic',
	description: 'A delivery signed with the subscription secret, verified at the same second.',
	secret: SECRET,
	body: BODY,
	header: header(T, good),
	now: T,
	expected: true,
	signedPayload: `${T}.${BODY}`,
	expectedV1: good
});
const uni = sign(SECRET, T, UNICODE_BODY);
add({
	name: 'valid-unicode-body',
	description: 'Non-ASCII body: the HMAC is over the UTF-8 bytes that were sent. Verify the raw body, never a re-serialised object.',
	secret: SECRET,
	body: UNICODE_BODY,
	header: header(T, uni),
	now: T,
	expected: true,
	expectedV1: uni
});
const empty = sign(SECRET, T, '{}');
add({
	name: 'valid-minimal-body',
	description: 'Smallest JSON body; the signed string is "<t>.{}".',
	secret: SECRET,
	body: '{}',
	header: header(T, empty),
	now: T,
	expected: true,
	signedPayload: `${T}.{}`,
	expectedV1: empty
});
add({
	name: 'valid-window-edge-late',
	description: 'Received exactly toleranceSeconds after signing: still accepted (the window is inclusive).',
	secret: SECRET,
	body: BODY,
	header: header(T, good),
	now: T + TOL,
	expected: true
});
add({
	name: 'valid-window-edge-early',
	description: 'Receiver clock toleranceSeconds behind the sender: still accepted.',
	secret: SECRET,
	body: BODY,
	header: header(T, good),
	now: T - TOL,
	expected: true
});
const prev = sign(PREVIOUS_SECRET, T, BODY);
add({
	name: 'valid-rotation-current-secret',
	description: 'During a secret rotation the header carries two v1 values (new first, previous second). A receiver holding the NEW secret accepts.',
	secret: SECRET,
	body: BODY,
	header: header(T, good, prev),
	now: T,
	expected: true
});
add({
	name: 'valid-rotation-previous-secret',
	description: 'Same rotation header; a receiver still holding the PREVIOUS secret accepts too (any v1 that verifies is enough).',
	secret: PREVIOUS_SECRET,
	body: BODY,
	header: header(T, good, prev),
	now: T,
	expected: true
});
add({
	name: 'invalid-tampered-body',
	description: 'The body changed after signing (one character).',
	secret: SECRET,
	body: BODY.replace('Ship the integration feed', 'Ship the integration food'),
	header: header(T, good),
	now: T,
	expected: false
});
add({
	name: 'invalid-reserialised-body',
	description: 'Same JSON value, different bytes (pretty-printed). A receiver must verify the raw bytes it received.',
	secret: SECRET,
	body: JSON.stringify(envelope, null, 2),
	header: header(T, good),
	now: T,
	expected: false
});
add({
	name: 'invalid-wrong-secret',
	description: 'Signed with another secret.',
	secret: SECRET,
	body: BODY,
	header: header(T, sign('not-the-subscription-secret', T, BODY)),
	now: T,
	expected: false
});
add({
	name: 'invalid-decoded-secret',
	description: 'Signed with the base64url-DECODED secret bytes. The HMAC key is the secret string exactly as returned by POST /webhooks (its UTF-8 bytes), never decoded.',
	secret: SECRET,
	body: BODY,
	header: header(T, createHmac('sha256', Buffer.from(SECRET, 'base64url')).update(`${T}.${BODY}`, 'utf8').digest('hex')),
	now: T,
	expected: false
});
add({
	name: 'invalid-expired',
	description: 'Received one second after the tolerance window (replay protection).',
	secret: SECRET,
	body: BODY,
	header: header(T, good),
	now: T + TOL + 1,
	expected: false
});
add({
	name: 'invalid-from-the-future',
	description: 'Timestamp more than toleranceSeconds ahead of the receiver clock.',
	secret: SECRET,
	body: BODY,
	header: header(T, good),
	now: T - TOL - 1,
	expected: false
});
add({
	name: 'invalid-timestamp-rewritten',
	description: 'A captured delivery replayed with a fresh t= but the old v1: fails because t is inside the signed string.',
	secret: SECRET,
	body: BODY,
	header: header(T + 3600, good),
	now: T + 3600,
	expected: false
});
add({
	name: 'invalid-body-only-signature',
	description: 'v1 computed over the body alone (the legacy v1 scheme, sha256=<hmac(body)>), not over "<t>.<body>".',
	secret: SECRET,
	body: BODY,
	header: header(T, hmac(SECRET, BODY)),
	now: T,
	expected: false
});
add({
	name: 'invalid-missing-timestamp',
	description: 'No t= part.',
	secret: SECRET,
	body: BODY,
	header: `v1=${good}`,
	now: T,
	expected: false
});
add({
	name: 'invalid-missing-signature',
	description: 'No v1= part.',
	secret: SECRET,
	body: BODY,
	header: `t=${T}`,
	now: T,
	expected: false
});
add({
	name: 'invalid-empty-header',
	description: 'Empty header value.',
	secret: SECRET,
	body: BODY,
	header: '',
	now: T,
	expected: false
});
add({
	name: 'invalid-non-numeric-timestamp',
	description: 't= is not a number.',
	secret: SECRET,
	body: BODY,
	header: `t=yesterday,v1=${good}`,
	now: T,
	expected: false
});
add({
	name: 'invalid-truncated-signature',
	description: 'v1 one hex digit short.',
	secret: SECRET,
	body: BODY,
	header: header(T, good.slice(0, 63)),
	now: T,
	expected: false
});
add({
	name: 'invalid-non-hex-signature',
	description: 'v1 has the right length but is not hex. Must be rejected, not throw (a constant-time compare on decoded buffers of different lengths throws in Node).',
	secret: SECRET,
	body: BODY,
	header: header(T, 'zz' + good.slice(2)),
	now: T,
	expected: false
});
add({
	name: 'invalid-legacy-scheme-header',
	description: 'The legacy v1-subscription header format (sha256=<hex>) presented as X-Ever-Works-Signature.',
	secret: SECRET,
	body: BODY,
	header: `sha256=${hmac(SECRET, BODY)}`,
	now: T,
	expected: false
});

const doc = {
	$schema: './schemas/webhook-signature-vectors.schema.json',
	contract: 'ever-works-integrations',
	contractVersion: '1',
	description:
		'Shared webhook signature test vectors (contract v1, B.5). Ever Works signs every webhooks-v2 delivery with X-Ever-Works-Signature; Ever Gauzy (verifyWebhookSignature in @gauzy/core) and any other receiver must reproduce `expected` for every vector. Generated by the script referenced in ../README.md; regenerate rather than hand-edit.',
	header: 'X-Ever-Works-Signature',
	format: 't=<unix-seconds>,v1=<lower-case hex HMAC-SHA256>[,v1=<...>]',
	signedPayload: '<t>.<raw body>  (the decimal t, one ASCII dot, then the exact body bytes as UTF-8)',
	hmacKey: 'The subscription secret string exactly as returned once by POST /webhooks or POST /webhooks/:id/rotate-secret, as UTF-8 bytes. Never base64-decode it.',
	toleranceSeconds: TOL,
	verification: [
		'Split the header on ",", trim each part; take the first t= part and every v1= part.',
		'Reject when t is missing or not a finite number, or when there is no v1.',
		'Reject when |now - t| > toleranceSeconds (inclusive window).',
		'Compute hex(HMAC-SHA256(secret, "<t>.<rawBody>")) and accept when ANY v1 equals it, compared in constant time; a v1 of a different length or not hex is a mismatch, never an exception.'
	],
	vectors: v
};
writeFileSync(join(contractDir, 'webhook-signature-vectors.json'), JSON.stringify(doc, null, '\t') + '\n');
console.log(v.length, 'vectors');
