/**
 * T8 — the App runner script (plan §4.8, §4.9, §4.10; spec FR-19/FR-35/FR-37, ACC-06-12).
 *
 * `http` jobs, `http` cron entries and every smoke run do not run the App's image with a generated
 * command line: they run this script on a digest-pinned public Node.js runtime image, mounted
 * read-only from a ConfigMap by `app-jobs.renderer.ts` (plan §4.8). Paths, bodies and expectations
 * are **data** — read with `JSON.parse` from a second mounted file — so no App-spec value is ever
 * interpolated into a shell or a command line (Constitution X, T8's `**Done when**` line).
 *
 * ## What the script does, and what it deliberately does not
 *
 * - One HTTP request per entry of the request list, with **`redirect: 'manual'`**: smoke, job and
 *   cron requests never follow a redirect, so `expect.status` judges the first response
 *   (CONTRACTS §1).
 * - `authEnv` becomes `Authorization: Bearer <value>` (`authScheme: bearer`, the default) or
 *   `Authorization: <value>` (`raw`, the APW-13 addition) — the value comes from the container
 *   environment, where the Job put it through a `secretKeyRef`.
 * - `{{env.NAME}}` placeholders in a body are resolved from that same environment. A placeholder
 *   whose value is unset fails the request **without sending it**, because a request carrying an
 *   empty credential is worse than no request at all.
 * - At most {@link APP_RUNNER_MAX_BODY_BYTES} of the response body is read (`expect.bodyContains`
 *   and `expect.bodyNotContains` therefore see the first MiB, spec FR-… "present (in the first
 *   1 MiB)").
 * - `found` is capped at {@link APP_RUNNER_FOUND_CHARS} and **scrubbed of every mounted secret
 *   value**, and the resolved body is never logged. The scrub runs before the cap, so a secret can
 *   never be cut in half into the output.
 * - The isolation probe of plan §4.10 is the same script in another mode: a TCP connect to
 *   `host:port` (the request data, else the kubelet-set `KUBERNETES_SERVICE_HOST` /
 *   `KUBERNETES_SERVICE_PORT`) with a 3 s timeout, reporting `connected` — never deciding what the
 *   answer means.
 *
 * ## Purity
 *
 * This file is a **string constant** plus its types and constants; it performs no I/O. The script
 * it carries reads the clock exactly once per request, for the `latencyMs` §4.8 requires of its
 * output record, and never schedules anything against the wall clock: every timeout is the
 * caller-supplied window, and the exit is `process.exitCode` rather than `process.exit()`, so a
 * pipe can never truncate the report.
 *
 * ## `APP_RUNNER_IMAGE`
 *
 * A public Node.js runtime image, **pinned by digest** so a moved tag can never change what runs in
 * a customer's namespace. `node:22-alpine`'s multi-arch (OCI image index) digest
 * `sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`, read from the public
 * Docker Hub registry API on 2026-09-18 — reviewed on bump, as §4.8 requires. The index digest is
 * deliberate: the runner must run on whatever architecture the customer's nodes are.
 */

/** Version of the request-list contract below. A payload is data, so it carries its own version. */
export const APP_RUNNER_SCRIPT_VERSION = 1;

/**
 * The runner image (plan §4.8: "a digest-pinned public Node.js runtime image"). Review on bump —
 * never a floating tag.
 */
export const APP_RUNNER_IMAGE = 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32';

/** Where `app-jobs.renderer.ts` mounts the runner ConfigMap. */
export const APP_RUNNER_MOUNT_PATH = '/etc/ever-works';
/** The mounted script — the container's `command` is `['node', APP_RUNNER_SCRIPT_FILE]`. */
export const APP_RUNNER_SCRIPT_FILE = `${APP_RUNNER_MOUNT_PATH}/runner.js`;
/** The mounted request list — the script's only input besides the environment. */
export const APP_RUNNER_REQUESTS_FILE = `${APP_RUNNER_MOUNT_PATH}/requests.json`;
/** The ConfigMap `data` key holding {@link APP_RUNNER_SCRIPT}. */
export const APP_RUNNER_CONFIGMAP_SCRIPT_KEY = 'runner.js';
/** The ConfigMap `data` key holding the request list. */
export const APP_RUNNER_CONFIGMAP_REQUESTS_KEY = 'requests.json';
/** The environment variable that names the request list (so a caller can move the mount). */
export const APP_RUNNER_REQUESTS_ENV = 'EVER_WORKS_RUNNER_REQUESTS';

/** The body cap: 1 MiB (plan §5.3 `APP_SMOKE_BODY_BYTES`). */
export const APP_RUNNER_MAX_BODY_BYTES = 1_048_576;
/** The `found` cap (plan §5.3 `APP_SMOKE_FOUND_CHARS`, §3.1 `CheckResult.found`). */
export const APP_RUNNER_FOUND_CHARS = 200;
/** What a secret value is replaced with inside `found`. */
export const APP_RUNNER_REDACTED = '***';
/** `expect.status` for an `http` job or cron that declares none (APW-03 schema §13). */
export const APP_RUNNER_DEFAULT_STATUS = [200, 201, 204] as const;
/** `expect.status` for a smoke check that declares none (APW-03 schema §16). */
export const APP_RUNNER_SMOKE_STATUS = [200] as const;
/** `expect.maxLatencyMs` when a smoke check declares none (APW-03 schema §16). */
export const APP_RUNNER_DEFAULT_MAX_LATENCY_MS = 10_000;
/** A request's own timeout when the request list does not name one. */
export const APP_RUNNER_DEFAULT_TIMEOUT_MS = 30_000;
/** The isolation probe's connect timeout (plan §5.3 `APP_ISOLATION_PROBE_TIMEOUT_S`). */
export const APP_RUNNER_PROBE_TIMEOUT_MS = 3_000;
/** Exit code when every request passed (or the probe reported). */
export const APP_RUNNER_EXIT_OK = 0;
/** Exit code when any request failed or the report could not be produced. */
export const APP_RUNNER_EXIT_FAILED = 1;

/** One request of the mounted list — paths, bodies and expectations, all data. */
export interface AppRunnerRequestData {
	/** The check's name, reported back verbatim. */
	name: string;
	/** The absolute URL, already built by the renderer. */
	url: string;
	/** `GET`/`HEAD`/`POST`/`PUT`/`PATCH`/`DELETE`. */
	method: string;
	/** Extra headers. `Host` comes from the URL authority (see the renderer's doc). */
	headers?: Record<string, string> | null;
	/** A JSON body whose string leaves may carry `{{env.NAME}}` placeholders. */
	body?: unknown;
	/** The env var — filled from a `secretKeyRef` — sent as `Authorization`. */
	authEnv?: string | null;
	/** `bearer` (default) or `raw`. */
	authScheme?: 'bearer' | 'raw' | null;
	/** What the first response must look like. */
	expect?: {
		status?: readonly number[] | null;
		bodyContains?: readonly string[] | null;
		bodyNotContains?: readonly string[] | null;
		maxLatencyMs?: number | null;
	} | null;
	/** The request's own deadline, milliseconds. */
	timeoutMs?: number | null;
}

/** The isolation probe's destination; both may be omitted to use the kubelet-set env vars. */
export interface AppRunnerIsolationProbe {
	host?: string | null;
	port?: number | null;
	timeoutMs?: number | null;
}

/** The whole mounted request list. */
export interface AppRunnerPayload {
	version: number;
	/** Which runner mode produced this list — reported, never branched on by the script. */
	kind: 'http-job' | 'smoke' | 'hairpin' | 'isolation-probe' | 'cron';
	/** The App-spec job or cron name this list belongs to, when it has one. */
	name?: string | null;
	requests: AppRunnerRequestData[];
	/** The env var names whose **values** must never appear in `found`. */
	secrets: string[];
	/** Set for the §4.10 isolation probe; the request list is then empty. */
	isolationProbe?: AppRunnerIsolationProbe | null;
}

/**
 * One JSON line of the script's output (plan §4.8: "one JSON line per request
 * `{ name, status, latencyMs, failedExpectation?, found? }`"). `status` is the **HTTP** status of
 * the first response; `ok` is the pass/fail verdict, so a caller never has to re-derive it.
 */
export interface AppRunnerRecord {
	kind: 'http' | 'isolation-probe' | 'runner';
	name: string;
	/** HTTP status of the first response; `0` when there was none. */
	status: number;
	ok: boolean;
	latencyMs: number;
	/** Bytes of the response body that were read (never more than the 1 MiB cap). */
	bytes?: number;
	/** True when the body was longer than the cap. */
	bodyTruncated?: boolean;
	/** The probe's answer: `true` means the destination answered (plan §4.10). */
	connected?: boolean;
	failedExpectation?: string;
	/** `≤ 200` characters, secret-scrubbed. */
	found?: string;
	reason?: string;
}

/**
 * The script, verbatim. Mounted as the ConfigMap's `runner.js` and executed by
 * `node /etc/ever-works/runner.js`.
 *
 * It is written with `String.raw` so the text below is exactly the text that runs: no escape is
 * doubled and no placeholder is interpolated. It deliberately uses `var`, string concatenation and
 * no template literals, so the script text contains no `${`/backtick that a TypeScript template
 * would try to interpret.
 */
export const APP_RUNNER_SCRIPT = String.raw`'use strict';

/**
 * Ever Works App runner (APW-06 plan 4.8, 4.9, 4.10).
 *
 * Reads the request list from the mounted JSON file, issues every request with
 * redirect: 'manual', and writes one JSON line per request to stdout. Paths, bodies and
 * expectations are data: nothing from the App spec is ever interpreted as a command.
 */

var fs = require('node:fs');
var net = require('node:net');

var MAX_BODY_BYTES = 1048576;
var FOUND_CHARS = 200;
var FOUND_MARGIN = 64;
var CONTEXT_CHARS = 40;
var REDACTED = '***';
var DEFAULT_STATUS = [200, 201, 204];
var DEFAULT_LATENCY_MS = 10000;
var DEFAULT_TIMEOUT_MS = 30000;
var DEFAULT_PROBE_TIMEOUT_MS = 3000;
var REQUESTS_FILE = process.env.EVER_WORKS_RUNNER_REQUESTS || '/etc/ever-works/requests.json';
var PLACEHOLDER = /{{env\.([A-Za-z_][A-Za-z0-9_]*)}}/g;

main();

function main() {
	var payload = readPayload();
	if (!payload) {
		return;
	}

	var secrets = secretValues(payload);

	if (payload.isolationProbe) {
		runIsolationProbe(payload.isolationProbe);
		return;
	}

	runRequests(payload, secrets);
}

function readPayload() {
	try {
		return JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf8'));
	} catch (error) {
		var code = error && error.code ? String(error.code) : 'unreadable';
		writeLine({
			kind: 'runner',
			name: 'runner',
			status: 0,
			ok: false,
			latencyMs: 0,
			failedExpectation: 'the runner request list at ' + REQUESTS_FILE + ' could not be read (' + code + ')'
		});
		process.exitCode = 1;
		return null;
	}
}

function runRequests(payload, secrets) {
	var requests = Array.isArray(payload.requests) ? payload.requests : [];
	var failed = false;
	var index = 0;

	function next() {
		if (index >= requests.length) {
			process.exitCode = failed ? 1 : 0;
			return;
		}
		var request = requests[index];
		index = index + 1;
		runRequest(request, secrets).then(function (ok) {
			if (!ok) {
				failed = true;
			}
			next();
		});
	}

	next();
}

function runRequest(request, secrets) {
	var name = request && typeof request.name === 'string' ? request.name : 'request';
	var expect = expectationsOf(request);
	var timeoutMs = finiteNumber(request && request.timeoutMs, DEFAULT_TIMEOUT_MS);
	var headers = {};
	var source = request && request.headers && typeof request.headers === 'object' ? request.headers : {};
	var headerNames = Object.keys(source);
	var index;

	for (index = 0; index < headerNames.length; index++) {
		headers[headerNames[index]] = String(source[headerNames[index]]);
	}

	var missing = [];
	var body = request && request.body !== undefined && request.body !== null ? resolveValue(request.body, missing) : undefined;
	if (missing.length > 0) {
		report(name, 0, false, 0, 'env ' + missing[0] + ' is not set, so the request was not sent', null, null);
		return Promise.resolve(false);
	}

	if (request && request.authEnv) {
		var credential = process.env[request.authEnv];
		if (typeof credential !== 'string' || credential.length === 0) {
			report(name, 0, false, 0, 'auth env ' + request.authEnv + ' is not set, so the request was not sent', null, null);
			return Promise.resolve(false);
		}
		headers.Authorization = (request.authScheme === 'raw' ? '' : 'Bearer ') + credential;
	}

	var init = { method: String((request && request.method) || 'POST'), redirect: 'manual', headers: headers };

	if (body !== undefined) {
		if (typeof body === 'string') {
			init.body = body;
		} else {
			init.body = JSON.stringify(body);
			if (!hasHeader(headers, 'content-type')) {
				headers['content-type'] = 'application/json';
			}
		}
	}

	var timer = null;
	var controller = null;
	if (typeof AbortController === 'function' && timeoutMs > 0) {
		controller = new AbortController();
		init.signal = controller.signal;
		timer = setTimeout(function () {
			if (controller) {
				controller.abort();
			}
		}, timeoutMs);
	}

	var startedAt = Date.now();
	return fetch(String(request && request.url), init).then(
		function (response) {
			var latencyMs = Date.now() - startedAt;
			if (timer) {
				clearTimeout(timer);
			}
			return readCapped(response, MAX_BODY_BYTES).then(function (read) {
				return judge(name, response, read, expect, secrets, latencyMs);
			});
		},
		function (error) {
			var latencyMs = Date.now() - startedAt;
			if (timer) {
				clearTimeout(timer);
			}
			var aborted = error && (error.name === 'AbortError' || String(error.message || '').indexOf('abort') >= 0);
			var message = aborted
				? 'the request timed out after ' + timeoutMs + ' ms'
				: 'request failed: ' + scrub(messageOf(error), secrets);
			report(name, 0, false, latencyMs, message, null, null);
			return false;
		}
	);
}

function judge(name, response, read, expect, secrets, latencyMs) {
	var status = finiteNumber(response && response.status, 0);
	var text = read.text;
	var index;

	if (expect.status.length > 0 && expect.status.indexOf(status) < 0) {
		report(name, status, false, latencyMs, 'status is one of ' + expect.status.join(', ') + ' but was ' + status, trimFound(text, -1, null, secrets), read);
		return false;
	}

	if (latencyMs > expect.maxLatencyMs) {
		report(name, status, false, latencyMs, 'latency must be at most ' + expect.maxLatencyMs + ' ms but was ' + latencyMs + ' ms', null, read);
		return false;
	}

	for (index = 0; index < expect.bodyContains.length; index++) {
		if (text.indexOf(expect.bodyContains[index]) < 0) {
			report(name, status, false, latencyMs, 'body must contain ' + JSON.stringify(expect.bodyContains[index]), trimFound(text, -1, null, secrets), read);
			return false;
		}
	}

	for (index = 0; index < expect.bodyNotContains.length; index++) {
		var at = text.indexOf(expect.bodyNotContains[index]);
		if (at >= 0) {
			report(name, status, false, latencyMs, 'body must not contain ' + JSON.stringify(expect.bodyNotContains[index]), trimFound(text, at, expect.bodyNotContains[index], secrets), read);
			return false;
		}
	}

	report(name, status, true, latencyMs, null, null, read);
	return true;
}

function report(name, status, ok, latencyMs, failedExpectation, found, read) {
	var record = { kind: 'http', name: name, status: status, ok: ok, latencyMs: latencyMs };
	if (read) {
		record.bytes = read.bytes;
		record.bodyTruncated = read.truncated;
	}
	if (failedExpectation) {
		record.failedExpectation = failedExpectation;
	}
	if (found) {
		record.found = found;
	}
	writeLine(record);
}

function readCapped(response, maxBytes) {
	if (!response || !response.body || typeof response.body.getReader !== 'function') {
		return Promise.resolve(response ? response.text() : '').then(function (text) {
			var value = typeof text === 'string' ? text : '';
			return { text: value, bytes: value.length, truncated: false };
		});
	}

	var reader = response.body.getReader();
	var decoder = new TextDecoder('utf-8');
	var bytes = 0;
	var truncated = false;
	var text = '';

	function done() {
		return { text: text, bytes: bytes, truncated: truncated };
	}

	function pump() {
		return reader.read().then(function (step) {
			if (step.done) {
				text = text + decoder.decode();
				return done();
			}
			var chunk = step.value;
			if (bytes + chunk.length > maxBytes) {
				// Decode the part that fits and stop reading: the rest of the body is never held in
				// memory, so a 1 GiB response cannot exhaust the runner's 128Mi limit.
				text = text + decoder.decode(chunk.subarray(0, maxBytes - bytes));
				bytes = maxBytes;
				truncated = true;
				if (typeof reader.cancel === 'function') {
					return reader.cancel().then(done, done);
				}
				return done();
			}
			bytes = bytes + chunk.length;
			text = text + decoder.decode(chunk, { stream: true });
			return pump();
		});
	}

	return pump();
}

function runIsolationProbe(probe) {
	var host = probe.host || process.env.KUBERNETES_SERVICE_HOST;
	var port = finiteNumber(probe.port, finiteNumber(process.env.KUBERNETES_SERVICE_PORT, 0));
	var timeoutMs = finiteNumber(probe.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS);

	if (!host || !port) {
		writeLine({
			kind: 'isolation-probe',
			name: 'isolation-probe',
			status: 0,
			ok: false,
			connected: false,
			latencyMs: 0,
			failedExpectation: 'the isolation probe has no host or port to connect to'
		});
		process.exitCode = 1;
		return;
	}

	var startedAt = Date.now();
	var settled = false;
	var socket = net.connect({ host: String(host), port: port });
	var timer = setTimeout(function () {
		finish(false, 'timeout');
	}, timeoutMs > 0 ? timeoutMs : DEFAULT_PROBE_TIMEOUT_MS);

	function finish(connected, reason) {
		if (settled) {
			return;
		}
		settled = true;
		clearTimeout(timer);
		try {
			socket.destroy();
		} catch (error) {
			/* the socket is already gone */
		}
		var record = {
			kind: 'isolation-probe',
			name: 'isolation-probe',
			status: 0,
			ok: true,
			connected: connected,
			latencyMs: Date.now() - startedAt
		};
		if (reason) {
			record.reason = reason;
		}
		writeLine(record);
		process.exitCode = 0;
	}

	socket.on('connect', function () {
		finish(true, null);
	});
	socket.on('error', function (error) {
		finish(false, messageOf(error));
	});
}

function expectationsOf(request) {
	var declared = request && request.expect && typeof request.expect === 'object' ? request.expect : {};
	var status = Array.isArray(declared.status) && declared.status.length > 0 ? declared.status : DEFAULT_STATUS;
	return {
		status: status.map(Number),
		bodyContains: Array.isArray(declared.bodyContains) ? declared.bodyContains.map(String) : [],
		bodyNotContains: Array.isArray(declared.bodyNotContains) ? declared.bodyNotContains.map(String) : [],
		maxLatencyMs: finiteNumber(declared.maxLatencyMs, DEFAULT_LATENCY_MS)
	};
}

function secretValues(payload) {
	var names = [];
	var declared = Array.isArray(payload.secrets) ? payload.secrets : [];
	var requests = Array.isArray(payload.requests) ? payload.requests : [];
	var index;

	for (index = 0; index < declared.length; index++) {
		pushName(names, declared[index]);
	}
	for (index = 0; index < requests.length; index++) {
		pushName(names, requests[index] && requests[index].authEnv);
		collectPlaceholders(requests[index] && requests[index].body, names);
	}

	var values = [];
	for (index = 0; index < names.length; index++) {
		var value = process.env[names[index]];
		if (typeof value === 'string' && value.length > 0) {
			values.push(value);
		}
	}
	return values.sort(function (left, right) {
		return right.length - left.length;
	});
}

function pushName(names, name) {
	if (typeof name === 'string' && name.length > 0 && names.indexOf(name) < 0) {
		names.push(name);
	}
}

function collectPlaceholders(value, names) {
	if (typeof value === 'string') {
		var matches = value.match(PLACEHOLDER);
		if (matches) {
			for (var index = 0; index < matches.length; index++) {
				pushName(names, matches[index].slice(6, matches[index].length - 2));
			}
		}
		return;
	}
	if (Array.isArray(value)) {
		for (var item = 0; item < value.length; item++) {
			collectPlaceholders(value[item], names);
		}
		return;
	}
	if (value && typeof value === 'object') {
		var keys = Object.keys(value);
		for (var key = 0; key < keys.length; key++) {
			collectPlaceholders(value[keys[key]], names);
		}
	}
}

function resolveValue(value, missing) {
	if (typeof value === 'string') {
		return value.replace(PLACEHOLDER, function (match, name) {
			var resolved = process.env[name];
			if (typeof resolved !== 'string') {
				if (missing.indexOf(name) < 0) {
					missing.push(name);
				}
				return '';
			}
			return resolved;
		});
	}
	if (Array.isArray(value)) {
		var list = [];
		for (var index = 0; index < value.length; index++) {
			list.push(resolveValue(value[index], missing));
		}
		return list;
	}
	if (value && typeof value === 'object') {
		var out = {};
		var keys = Object.keys(value);
		for (var key = 0; key < keys.length; key++) {
			out[keys[key]] = resolveValue(value[keys[key]], missing);
		}
		return out;
	}
	return value;
}

function trimFound(text, at, needle, secrets) {
	var raw = String(text == null ? '' : text);
	var context;

	if (at >= 0 && needle) {
		context = raw.slice(Math.max(0, at - CONTEXT_CHARS), at + needle.length + CONTEXT_CHARS);
	} else {
		context = raw.slice(0, FOUND_CHARS + FOUND_MARGIN);
	}

	return scrub(context, secrets).slice(0, FOUND_CHARS);
}

function scrub(text, secrets) {
	var out = String(text == null ? '' : text);
	for (var index = 0; index < secrets.length; index++) {
		if (secrets[index]) {
			out = out.split(secrets[index]).join(REDACTED);
		}
	}
	return out;
}

function messageOf(error) {
	if (!error) {
		return 'unknown error';
	}
	if (error.code) {
		return String(error.code);
	}
	return String(error.message || error);
}

function finiteNumber(value, fallback) {
	var number = typeof value === 'number' ? value : Number(value);
	return typeof number === 'number' && isFinite(number) ? number : fallback;
}

function hasHeader(headers, name) {
	var keys = Object.keys(headers);
	for (var index = 0; index < keys.length; index++) {
		if (keys[index].toLowerCase() === name) {
			return true;
		}
	}
	return false;
}

function writeLine(record) {
	process.stdout.write(JSON.stringify(record) + '\n');
}
`;
