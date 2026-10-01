#!/usr/bin/env node
/**
 * Ever Works App Works — golden artifact check (zero dependencies).
 *
 * WHAT THIS IS
 * ------------
 * The three App Blueprints under `APW-13-golden-paths/blueprints/` each have a golden directory
 * (`golden/<blueprint>/`) holding the exact files the platform is specified to generate for them:
 *
 *   ever-works-build.yml        the workflow APW-05 writes into the Work Repository
 *   your-cluster/*.yaml         the objects APW-06 renders for the `your-cluster` target
 *   ever-works-apps/work.yaml   the `Work` resource APW-10's tier consumes (desired state, not objects)
 *
 * This script reads each Blueprint's `.works/works.yml` **at run time** and proves the golden files
 * still follow from it. Nothing here is a fixture constant that could silently rot: the expected
 * component names, ports, probe paths, job order, cron schedules, env key set and image digests are
 * all recomputed from the App spec on every run.
 *
 * USAGE
 * -----
 *   cd docs/specs/features/app-works/_build-artifacts/expected-outputs/golden
 *   node check.mjs                                   # checks all three Blueprints, exits 0 when clean
 *   node check.mjs --blueprint app-fixture-hello      # one Blueprint
 *   node check.mjs --root __negative-control__/nc-01-port   # a deliberately corrupted copy
 *
 * Exit code 1 means at least one assertion failed; each failure names the golden file and the field.
 *
 * WHAT IT CANNOT CHECK
 * --------------------
 * Only DESIRED STATE. Rollout, rollback, smoke execution and the deploy-time runner Jobs (smoke,
 * hairpin, isolation probe — APW-06 plan §4.11–§4.12) are out of the golden set by design, and the
 * two `run:` bodies inside `ever-works-build.yml` are placeholders because the specs own their text
 * in source files, not in prose. See README.md §"What is NOT in this set".
 *
 * The YAML reader below is a deliberately small subset parser (block maps/sequences, flow
 * collections, quoted scalars, `|` block scalars, comments) — enough for an App spec and the
 * rendered objects, and enough to keep this file dependency-free.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Walk up until the App Works spec directory is found — works from a copy, too. */
function findRepoRoot(start) {
	let current = start;
	for (let depth = 0; depth < 12; depth += 1) {
		if (
			fs.existsSync(path.join(current, 'docs', 'specs', 'features', 'app-works', 'APW-06-app-runtime', 'plan.md'))
		) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error(`cannot locate the repository root above ${start}`);
}

const REPO_ROOT = findRepoRoot(HERE);
const BLUEPRINTS_REL = 'docs/specs/features/app-works/APW-13-golden-paths/blueprints';

const argv = process.argv.slice(2);
let ROOT = HERE;
let BLUEPRINTS = ['app-fixture-hello', 'cal-diy', 'umami'];
for (let index = 0; index < argv.length; index += 1) {
	if (argv[index] === '--root') ROOT = path.resolve(process.cwd(), argv[index + 1]);
	else if (argv[index] === '--blueprint') BLUEPRINTS = [argv[index + 1]];
	else if (argv[index] === '--help' || argv[index] === '-h') {
		process.stdout.write('usage: node check.mjs [--root <golden dir>] [--blueprint <id>]\n');
		process.exit(0);
	}
}

/**
 * Render inputs the App spec does not carry — pinned per Blueprint, placeholders only.
 * Every one of these is listed in README.md §"Values chosen"; none is a real cluster, host or secret.
 */
const PINS = {
	'app-fixture-hello': {
		slug: 'app-fixture-hello',
		workId: '22222222-2222-4222-8222-222222222222',
		ownerUserId: '44444444-4444-4444-8444-444444444444',
		deploymentId: '77777777-7777-4777-8777-777777777777',
		specCommitSha: 'b1c2d3e4f5061728394a5b5c6d7e8f9012345678',
		imageRepository: 'ghcr.io/example-owner/app-fixture-hello/ever-works-app',
		imageDigest: 'sha256:a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00',
		buildImage: null
	},
	'cal-diy': {
		slug: 'cal-diy',
		workId: '11111111-1111-4111-8111-111111111111',
		ownerUserId: '55555555-5555-4555-8555-555555555555',
		deploymentId: '88888888-8888-4888-8888-888888888888',
		specCommitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
		imageRepository: 'ghcr.io/example-owner/cal.diy/ever-works-app',
		imageDigest: 'sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
		buildImage: null
	},
	umami: {
		slug: 'umami',
		workId: '33333333-3333-4333-8333-333333333333',
		ownerUserId: '66666666-6666-4666-8666-666666666666',
		deploymentId: '99999999-9999-4999-8999-999999999999',
		specCommitSha: 'c3d4e5f60718293a4b5c6d7e8f9012345678b1c2',
		imageRepository: 'ghcr.io/umami-software/umami',
		imageDigest: 'sha256:85909afc45bdcda1917394594a087421fdbb05610fded0fa9f6fb861abb2f367',
		buildImage:
			'ghcr.io/umami-software/umami@sha256:85909afc45bdcda1917394594a087421fdbb05610fded0fa9f6fb861abb2f367'
	}
};

/**
 * APW-05 plan.md:816-829 `BUILD_SERVICE_DEFAULTS` — the throwaway credentials of an ephemeral build
 * service. They are "non-secret by construction" and are the only literals a generated workflow may
 * carry next to a `POSTGRES_*` name.
 */
const BUILD_SERVICE_DEFAULT_LITERALS = new Set(['ever-works-build']);

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** APW-06 plan §4.7 — the value the platform would hold for one `spec.env[]` entry (never a secret). */
function specEnvValue(entry, bp) {
	const { pin } = bp;
	if (entry.secret === true) {
		if (entry.generate) {
			const size = entry.generate.bytes ?? entry.generate.length ?? '';
			return `<generated:${entry.generate.kind}${size === '' ? '' : `:${size}`}>`;
		}
		if (entry.prompt) return `<prompted:${entry.name}>`;
		if (entry.from) return `<${entry.from}>`;
		if (entry.template) return `<template:${entry.template}>`;
		return `<placeholder:${entry.name}>`;
	}
	if (entry.value !== undefined) return String(entry.value);
	if (entry.from === 'build.commitSha') return pin.specCommitSha;
	if (entry.from === 'domains.primary.url') return pin.primaryUrl;
	if (entry.from && entry.from.startsWith('components.') && entry.from.endsWith('.internalUrl')) {
		return `http://${entry.from.split('.')[1]}.${pin.namespace}.svc.cluster.local`;
	}
	if (entry.from) return `<${entry.from}>`;
	if (entry.template) return `<template:${entry.template}>`;
	if (entry.prompt) return `<prompted:${entry.name}>`;
	return `<unresolved:${entry.name}>`;
}

/** Recompute the env checksum the Secret and ConfigMap names and the pod annotation must carry. */
function envChecksum(bp) {
	const runtime = bp.spec.env.filter((entry) => (entry.phase ?? 'runtime') !== 'build');
	const lines = [
		...runtime.map((entry) => `${entry.name}=${specEnvValue(entry, bp)}`),
		...Object.entries(bp.pin.platformConfig).map(([name, value]) => `${name}=${value}`)
	].sort();
	return sha256(lines.join('\n'));
}

function secretKeys(objects) {
	const secret = objects.find(
		(o) => o.doc?.kind === 'Secret' && String(o.doc.metadata?.name ?? '').startsWith('app-env-')
	);
	return Object.keys(secret?.doc?.stringData ?? {});
}

function runnerRequestList(objects) {
	const configMap = objects.find((o) => o.doc?.kind === 'ConfigMap' && /ew-runner-/.test(o.doc.metadata?.name ?? ''));
	const text = configMap?.doc?.data?.['requests.json'];
	if (typeof text !== 'string') return [];
	try {
		return JSON.parse(text);
	} catch {
		return [];
	}
}

/* ---------- the zero-dependency YAML reader (inlined) -------------------------------- */

// In block context `key: value` needs a space (or end of line) after the colon — without it the
// whole token is a plain scalar (`fc00::/7` is a CIDR, not a mapping).
const KEY_RE = /^([^:\s][^:]*?)\s*:(?:\s+([\s\S]*))?$/;

function stripComment(line) {
	let out = '';
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if (inSingle) {
			out += ch;
			if (ch === "'") {
				if (line[i + 1] === "'") {
					out += line[i + 1];
					i += 1;
				} else inSingle = false;
			}
			continue;
		}
		if (inDouble) {
			out += ch;
			if (ch === '\\') {
				out += line[i + 1] ?? '';
				i += 1;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			out += ch;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			out += ch;
			continue;
		}
		if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
		out += ch;
	}
	return out;
}

function unescapeDouble(text) {
	return text.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (match, body) => {
		switch (body[0]) {
			case 'n':
				return '\n';
			case 't':
				return '\t';
			case 'r':
				return '\r';
			case '0':
				return '\0';
			case 'u':
			case 'x':
				return String.fromCharCode(parseInt(body.slice(1), 16));
			default:
				return body;
		}
	});
}

function scalar(text) {
	const trimmed = text.trim();
	if (trimmed === '' || trimmed === '~' || trimmed === 'null') return null;
	if (trimmed === 'true') return true;
	if (trimmed === 'false') return false;
	if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
	if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);
	if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
		return trimmed.slice(1, -1).replace(/''/g, "'");
	}
	if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
		return unescapeDouble(trimmed.slice(1, -1));
	}
	return trimmed;
}

/** Parse a flow collection starting at `text[from]`; returns { value, next } or throws. */
function parseFlow(text, from) {
	let i = from;
	const skip = () => {
		while (i < text.length && /[\s]/.test(text[i])) i += 1;
	};
	const fail = (why) => {
		throw new Error(`flow parse error at offset ${i}: ${why} :: ${JSON.stringify(text.slice(0, 120))}`);
	};
	const parseQuoted = () => {
		const quote = text[i];
		let out = '';
		i += 1;
		while (i < text.length) {
			const ch = text[i];
			if (quote === "'") {
				if (ch === "'") {
					if (text[i + 1] === "'") {
						out += "'";
						i += 2;
						continue;
					}
					i += 1;
					return out;
				}
				out += ch;
				i += 1;
				continue;
			}
			if (ch === '\\') {
				out += unescapeDouble(text.slice(i, i + 2));
				i += 2;
				continue;
			}
			if (ch === '"') {
				i += 1;
				return out;
			}
			out += ch;
			i += 1;
		}
		return fail('unterminated quoted scalar');
	};
	const parsePlain = (stops) => {
		let out = '';
		while (i < text.length && !stops.includes(text[i])) {
			out += text[i];
			i += 1;
		}
		return out.trim();
	};
	const parseValue = () => {
		skip();
		const ch = text[i];
		if (ch === '{' || ch === '[') return parseCollection();
		if (ch === "'" || ch === '"') return parseQuoted();
		return scalar(parsePlain(',}]'));
	};
	const parseCollection = () => {
		const open = text[i];
		const close = open === '{' ? '}' : ']';
		i += 1;
		skip();
		if (text[i] === close) {
			i += 1;
			return open === '{' ? {} : [];
		}
		if (open === '[') {
			const arr = [];
			for (;;) {
				arr.push(parseValue());
				skip();
				if (text[i] === ',') {
					i += 1;
					continue;
				}
				if (text[i] === close) {
					i += 1;
					return arr;
				}
				return fail(`expected "," or "${close}"`);
			}
		}
		const obj = {};
		for (;;) {
			skip();
			const key = text[i] === "'" || text[i] === '"' ? parseQuoted() : parsePlain(':,}');
			skip();
			if (text[i] !== ':') return fail(`expected ":" after key "${key}"`);
			i += 1;
			obj[key] = parseValue();
			skip();
			if (text[i] === ',') {
				i += 1;
				continue;
			}
			if (text[i] === close) {
				i += 1;
				return obj;
			}
			return fail(`expected "," or "${close}"`);
		}
	};
	const value = parseValue();
	return { value, next: i };
}

/** Index just past the flow collection that starts at the first bracket, or -1 when unbalanced. */
function flowEnd(text) {
	let depth = 0;
	let inSingle = false;
	let inDouble = false;
	let started = false;
	for (let k = 0; k < text.length; k += 1) {
		const ch = text[k];
		if (inSingle) {
			if (ch === "'") {
				if (text[k + 1] === "'") k += 1;
				else inSingle = false;
			}
			continue;
		}
		if (inDouble) {
			if (ch === '\\') {
				k += 1;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === '{' || ch === '[') {
			depth += 1;
			started = true;
			continue;
		}
		if (ch === '}' || ch === ']') {
			depth -= 1;
			if (started && depth === 0) return k + 1;
		}
	}
	return -1;
}

function parseYaml(source) {
	const rawLines = source.split(/\r?\n/);
	const lines = rawLines.map((raw, index) => {
		const text = stripComment(raw);
		return { n: index + 1, raw, text, indent: (raw.match(/^ */) ?? [''])[0].length, blank: text.trim() === '' };
	});
	const paths = new Map();
	let i = 0;

	const record = (pointer, line) => {
		if (!paths.has(pointer)) paths.set(pointer, line);
	};
	const skipBlank = () => {
		while (i < lines.length && lines[i].blank) i += 1;
	};

	function blockScalar(header, parentIndent, pointer, lineNo) {
		const keep = header.startsWith('|+');
		const strip = header.startsWith('|-');
		i += 1;
		const collected = [];
		let blockIndent = null;
		while (i < lines.length) {
			const line = lines[i];
			if (line.raw.trim() === '') {
				collected.push('');
				i += 1;
				continue;
			}
			if (line.indent <= parentIndent) break;
			if (blockIndent === null) blockIndent = line.indent;
			collected.push(line.raw.slice(Math.min(blockIndent, line.raw.length)));
			i += 1;
		}
		while (collected.length && collected[collected.length - 1] === '') collected.pop();
		record(pointer, lineNo);
		let value = collected.join('\n');
		if (!strip) value += '\n';
		if (keep) value += '\n';
		return value;
	}

	/** A flow collection that may span lines. Consumes every line it touches. */
	function flowBlock(startLine, startColumn) {
		let buffer = '';
		let j = startLine;
		let column = startColumn;
		for (;;) {
			if (j >= lines.length) throw new Error(`line ${startLine + 1}: unterminated flow collection`);
			buffer += (buffer === '' ? '' : '\n') + lines[j].text.slice(column);
			if (flowEnd(buffer) >= 0) {
				const { value } = parseFlow(buffer, 0);
				i = j + 1;
				return value;
			}
			j += 1;
			column = 0;
		}
	}

	function mapAt(indent, pointer) {
		const obj = {};
		record(pointer, lines[i]?.n);
		for (;;) {
			skipBlank();
			if (i >= lines.length) break;
			const line = lines[i];
			if (line.indent < indent) break;
			if (line.indent > indent) throw new Error(`line ${line.n}: unexpected indent (expected ${indent})`);
			const trimmed = line.text.trim();
			if (trimmed.startsWith('- ') || trimmed === '-') break;
			const match = KEY_RE.exec(trimmed);
			if (!match) throw new Error(`line ${line.n}: not a mapping entry: ${JSON.stringify(trimmed)}`);
			const key = match[1].trim();
			const rest = match[2] ?? '';
			const childPointer = `${pointer}/${key}`;
			record(childPointer, line.n);
			if (rest === '' || rest.startsWith('#')) {
				i += 1;
				skipBlank();
				if (i < lines.length && lines[i].indent > indent) {
					obj[key] = nodeAt(lines[i].indent, childPointer);
				} else if (
					i < lines.length &&
					!lines[i].blank &&
					lines[i].indent === indent &&
					/^-\s|^-$/.test(lines[i].text.trim())
				) {
					obj[key] = sequenceAt(indent, childPointer);
				} else {
					obj[key] = null;
				}
				continue;
			}
			if (rest.startsWith('|')) {
				obj[key] = blockScalar(rest, indent, childPointer, line.n);
				continue;
			}
			if (rest.startsWith('{') || rest.startsWith('[')) {
				obj[key] = flowBlock(i, line.text.indexOf(rest[0]));
				continue;
			}
			obj[key] = scalar(rest);
			i += 1;
		}
		return obj;
	}

	function sequenceAt(indent, pointer) {
		const arr = [];
		record(pointer, lines[i]?.n);
		for (;;) {
			skipBlank();
			if (i >= lines.length) break;
			const line = lines[i];
			if (line.indent < indent) break;
			if (line.indent > indent)
				throw new Error(`line ${line.n}: unexpected indent in sequence (expected ${indent})`);
			const trimmed = line.text.trim();
			if (!(trimmed === '-' || trimmed.startsWith('- '))) break;
			const index = arr.length;
			const childPointer = `${pointer}/${index}`;
			if (trimmed === '-') {
				i += 1;
				skipBlank();
				arr.push(i < lines.length && lines[i].indent > indent ? nodeAt(lines[i].indent, childPointer) : null);
				continue;
			}
			const rest = trimmed.slice(2);
			const column = line.indent + 2;
			if (rest.startsWith('|')) {
				arr.push(blockScalar(rest, indent, childPointer, line.n));
				continue;
			}
			if (rest.startsWith('{') || rest.startsWith('[')) {
				record(childPointer, line.n);
				arr.push(flowBlock(i, line.text.indexOf(rest[0])));
				continue;
			}
			const match = KEY_RE.exec(rest);
			if (match && !rest.startsWith("'") && !rest.startsWith('"')) {
				record(childPointer, line.n);
				const obj = {};
				const key = match[1].trim();
				const value = match[2] ?? '';
				record(`${childPointer}/${key}`, line.n);
				if (value === '') {
					i += 1;
					skipBlank();
					obj[key] =
						i < lines.length && lines[i].indent > column
							? nodeAt(lines[i].indent, `${childPointer}/${key}`)
							: null;
				} else if (value.startsWith('|')) {
					obj[key] = blockScalar(value, column, `${childPointer}/${key}`, line.n);
				} else if (value.startsWith('{') || value.startsWith('[')) {
					obj[key] = flowBlock(i, lines[i].text.indexOf(value[0]));
				} else {
					obj[key] = scalar(value);
					i += 1;
				}
				skipBlank();
				if (i < lines.length && lines[i].indent >= column && !lines[i].blank) {
					const tail = mapAt(column, childPointer);
					Object.assign(obj, tail);
				}
				arr.push(obj);
				continue;
			}
			record(childPointer, line.n);
			arr.push(scalar(rest));
			i += 1;
		}
		return arr;
	}

	function nodeAt(indent, pointer) {
		const trimmed = lines[i].text.trim();
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
			return flowBlock(i, lines[i].text.indexOf(trimmed[0]));
		}
		if (trimmed.startsWith('- ') || trimmed === '-') return sequenceAt(indent, pointer);
		return mapAt(indent, pointer);
	}

	skipBlank();
	const value = i < lines.length ? nodeAt(lines[i].indent, '') : null;
	skipBlank();
	if (i < lines.length) throw new Error(`line ${lines[i].n}: trailing content after the document`);
	return { value, lines: paths };
}

/** Dotted/JSON-pointer lookup that tolerates missing links. */
function at(root, pointer) {
	return String(pointer)
		.split('/')
		.filter((part) => part !== '')
		.reduce((acc, part) => (acc === undefined || acc === null ? undefined : acc[part]), root);
}

/* ================================================================================================
 * GOLDEN CHECKS
 * ============================================================================================== */

const results = [];
const BLUEPRINT_SHAS = {};
let current = null;

function suite(id, title) {
	current = { id, title, checks: [], failures: [] };
	results.push(current);
}

function ok(id, condition, message, where) {
	const passed = Boolean(condition);
	current.checks.push({ id, passed, message, where });
	if (!passed) current.failures.push({ id, message, where });
	return passed;
}

const show = (value) => (typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value)));

function eq(id, actual, expected, field, file) {
	return ok(id, actual === expected, `${field} is ${show(actual)}, expected ${show(expected)}`, file);
}

function walkFiles(root, prefix = '') {
	const out = [];
	for (const entry of fs
		.readdirSync(path.join(root, prefix), { withFileTypes: true })
		.sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walkFiles(root, rel));
		else out.push(rel);
	}
	return out;
}

function loadBlueprint(id) {
	const file = path.join(REPO_ROOT, BLUEPRINTS_REL, id, '.works', 'works.yml');
	const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
	const parsed = parseYaml(text);
	const pin = { ...PINS[id] };
	pin.namespace = `ew-${pin.slug}-${pin.workId.replace(/-/g, '').slice(0, 8)}`;
	pin.deploymentShort = pin.deploymentId.replace(/-/g, '').slice(0, 8);
	pin.primaryHost = `${pin.slug}.ever.works`;
	pin.primaryUrl = `https://${pin.primaryHost}`;
	pin.specSha256 = sha256(text);
	pin.workImage = pin.buildImage ?? `${pin.imageRepository}@${pin.imageDigest}`;
	pin.platformConfig = {
		EVER_WORKS_APP_HOST: pin.primaryHost,
		EVER_WORKS_APP_URL: pin.primaryUrl,
		EVER_WORKS_APP_COMMIT: pin.specCommitSha,
		EVER_WORKS_DEPLOYMENT_ID: pin.deploymentId
	};
	BLUEPRINT_SHAS[id] = pin.specSha256;
	return {
		id,
		file: path.relative(REPO_ROOT, file).replace(/\\/g, '/'),
		text,
		doc: parsed.value,
		lines: parsed.lines,
		spec: parsed.value.spec,
		pin
	};
}

function loadGolden(root, id) {
	const base = path.join(root, id);
	const files = walkFiles(base).filter((rel) => rel.endsWith('.yaml') || rel.endsWith('.yml'));
	const objects = [];
	for (const rel of files) {
		const text = fs.readFileSync(path.join(base, rel), 'utf8');
		let doc = null;
		let error = null;
		try {
			doc = parseYaml(text).value;
		} catch (parseError) {
			error = parseError.message;
		}
		objects.push({ rel: `${id}/${rel}`, text, doc, error });
	}
	const byKind = (kind) => objects.filter((o) => o.doc && o.doc.kind === kind);
	const fromCluster = (kind) =>
		objects.filter((o) => o.doc && o.doc.kind === kind && o.rel.includes('/your-cluster/'));
	return { base, files, objects, byKind, fromCluster };
}

const isPlaceholder = (value) => typeof value === 'string' && /^<[^<>]*>$/.test(value);
const imageFields = (doc) => {
	const found = [];
	const visit = (node, pointer) => {
		if (Array.isArray(node)) node.forEach((item, index) => visit(item, `${pointer}/${index}`));
		else if (node && typeof node === 'object') {
			for (const [key, value] of Object.entries(node)) {
				if (key === 'image' && typeof value === 'string') found.push({ pointer: `${pointer}/${key}`, value });
				else visit(value, `${pointer}/${key}`);
			}
		}
	};
	visit(doc, '');
	return found;
};

const envValueOf = (entry) => {
	if (entry.secret === true) return undefined;
	if (entry.value !== undefined) return String(entry.value);
	return undefined;
};

/* ------------------------------------------------------------------ run */

for (const id of BLUEPRINTS) {
	const bp = loadBlueprint(id);
	const golden = loadGolden(ROOT, id);
	const { spec, pin } = bp;
	const yourCluster = golden.objects.filter((o) => o.rel.includes('/your-cluster/'));
	const clusterKind = (kind, name) =>
		yourCluster.find((o) => o.doc?.kind === kind && (!name || o.doc?.metadata?.name === name));

	/* -- 1 ── every golden file parses, and the object set is the one the App spec implies ------- */
	suite(`${id} · 1 · the file set`, 'every expected object is present, nothing extra is rendered');
	for (const object of golden.objects) {
		ok(
			'1.1',
			object.error === null,
			object.error === null ? `${object.rel} parses` : `${object.rel} does not parse: ${object.error}`,
			object.rel
		);
	}
	const expectedFiles = [];
	expectedFiles.push(
		'your-cluster/00-namespace.yaml',
		'your-cluster/01-serviceaccount.yaml',
		'your-cluster/02-limitrange.yaml'
	);
	expectedFiles.push(
		'your-cluster/03-configmap-platform.yaml',
		'your-cluster/04-secret-env.yaml',
		'your-cluster/05-secret-pull.yaml'
	);
	for (const component of spec.components) {
		for (const volume of component.volumes ?? []) {
			expectedFiles.push(`your-cluster/06-persistentvolumeclaim-${component.name}-${volume.name}.yaml`);
		}
	}
	spec.components.forEach((component, index) => {
		expectedFiles.push(`your-cluster/1${index}-deployment-${component.name}.yaml`);
	});
	for (const component of spec.components.filter((c) => c.role === 'web')) {
		expectedFiles.push(`your-cluster/20-service-${component.name}.yaml`);
	}
	expectedFiles.push(`your-cluster/21-ingress-${spec.domains.primaryComponent}.yaml`);
	['ew-default-deny', 'ew-allow-same-namespace', 'ew-allow-ingress', 'ew-allow-egress', 'ew-allow-deps'].forEach(
		(name, index) => expectedFiles.push(`your-cluster/3${index}-networkpolicy-${name}.yaml`)
	);
	expectedFiles.push('your-cluster/40-configmap-runner.yaml');
	(spec.jobs ?? []).forEach((job, index) => expectedFiles.push(`your-cluster/5${index}-job-${job.name}.yaml`));
	(spec.cron ?? []).forEach((cron, index) => expectedFiles.push(`your-cluster/6${index}-cronjob-${cron.name}.yaml`));
	expectedFiles.push('ever-works-apps/work.yaml');
	expectedFiles.push('ever-works-build.yml');
	for (const rel of expectedFiles) {
		ok('1.2', golden.files.includes(rel), `${rel} exists`, `${id}/${rel}`);
	}
	for (const rel of golden.files) {
		ok(
			'1.3',
			expectedFiles.includes(rel),
			`${rel} is derived from the App spec (not an extra object)`,
			`${id}/${rel}`
		);
	}

	/* -- 2 ── component names and ports match the App spec -------------------------------------- */
	suite(`${id} · 2 · components and ports`, 'Deployments, Services and ports come from spec.components');
	for (const component of spec.components) {
		const deployment = clusterKind('Deployment', component.name);
		const where = `${id}/${expectedFiles.find((f) => f.includes(`-deployment-${component.name}.yaml`))}`;
		if (!ok('2.1', Boolean(deployment), `a Deployment named \`${component.name}\` exists`, where)) continue;
		const containers = deployment.doc.spec?.template?.spec?.containers ?? [];
		eq('2.2', containers.length, 1, `${where} container count`, where);
		eq('2.3', containers[0]?.name, component.name, `${where} container name`, where);
		eq('2.4', deployment.doc.spec?.replicas, component.replicas ?? 1, `${where} spec.replicas`, where);
		const ports = containers[0]?.ports ?? [];
		if (component.role === 'web') {
			eq('2.5', ports[0]?.containerPort, component.port, `${where} containerPort`, where);
			const service = clusterKind('Service', component.name);
			const serviceWhere = `${id}/your-cluster/20-service-${component.name}.yaml`;
			if (
				ok(
					'2.6',
					Boolean(service),
					`a ClusterIP Service exists for web component \`${component.name}\``,
					serviceWhere
				)
			) {
				eq('2.7', service.doc.spec?.type, 'ClusterIP', `${serviceWhere} spec.type`, serviceWhere);
				eq('2.8', service.doc.spec?.ports?.[0]?.port, 80, `${serviceWhere} Service port`, serviceWhere);
				eq(
					'2.9',
					service.doc.spec?.ports?.[0]?.targetPort,
					component.port,
					`${serviceWhere} targetPort`,
					serviceWhere
				);
				eq(
					'2.10',
					service.doc.spec?.selector?.['ever-works.io/component'],
					component.name,
					`${serviceWhere} selector`,
					serviceWhere
				);
			}
		} else {
			ok('2.11', ports.length === 0, `worker \`${component.name}\` declares no container port`, where);
			ok(
				'2.12',
				!clusterKind('Service', component.name) && !clusterKind('Ingress', component.name),
				`worker \`${component.name}\` gets no Service and no Ingress`,
				where
			);
		}
		eq(
			'2.13',
			deployment.doc.spec?.selector?.matchLabels?.['ever-works.io/component'],
			component.name,
			`${where} selector`,
			where
		);
	}
	const ingresses = yourCluster.filter((o) => o.doc?.kind === 'Ingress');
	eq('2.14', ingresses.length, 1, `${id} Ingress count`, `${id}/your-cluster/21-ingress-*.yaml`);
	eq(
		'2.15',
		ingresses[0]?.doc?.metadata?.name,
		spec.domains.primaryComponent,
		'Ingress is on domains.primaryComponent',
		ingresses[0]?.rel
	);

	/* -- 3 ── every probe target exists in the spec --------------------------------------------- */
	suite(`${id} · 3 · probes`, 'every probe path is declared in the App spec, with the spec’s numbers');
	const declaredProbePaths = new Set();
	for (const component of spec.components) {
		for (const probe of Object.values(component.probes ?? {})) {
			if (probe?.http) declaredProbePaths.add(probe.http);
		}
	}
	for (const object of yourCluster.filter((o) => o.doc?.kind === 'Deployment')) {
		const component = spec.components.find((c) => c.name === object.doc.metadata.name);
		const container = object.doc.spec.template.spec.containers[0];
		const probes = {
			startupProbe: container.startupProbe,
			readinessProbe: container.readinessProbe,
			livenessProbe: container.livenessProbe
		};
		for (const [key, probe] of Object.entries(probes)) {
			if (!probe) continue;
			const path_ = probe.httpGet?.path ?? probe.tcpSocket?.port;
			if (probe.httpGet) {
				ok(
					'3.1',
					declaredProbePaths.has(probe.httpGet.path),
					`${object.rel} ${key} targets ${show(probe.httpGet.path)}, which the App spec declares`,
					object.rel
				);
			}
			eq('3.2', probe.httpGet?.port ?? probe.tcpSocket?.port, 'http', `${object.rel} ${key} port`, object.rel);
			void path_;
		}
		const declared = component.probes ?? {};
		for (const [name, key] of [
			['startup', 'startupProbe'],
			['readiness', 'readinessProbe'],
			['liveness', 'livenessProbe']
		]) {
			const fromSpec = declared[name];
			const rendered = probes[key];
			if (fromSpec) {
				if (!ok('3.3', Boolean(rendered), `${object.rel} renders the declared ${name} probe`, object.rel))
					continue;
				eq('3.4', rendered.httpGet?.path, fromSpec.http, `${object.rel} ${name} path`, object.rel);
				eq(
					'3.5',
					rendered.periodSeconds,
					fromSpec.periodSeconds ?? 10,
					`${object.rel} ${name} periodSeconds`,
					object.rel
				);
				eq(
					'3.6',
					rendered.failureThreshold,
					fromSpec.failureThreshold ?? 3,
					`${object.rel} ${name} failureThreshold`,
					object.rel
				);
				eq(
					'3.7',
					rendered.timeoutSeconds,
					fromSpec.timeoutSeconds ?? 5,
					`${object.rel} ${name} timeoutSeconds`,
					object.rel
				);
				eq(
					'3.8',
					rendered.initialDelaySeconds,
					fromSpec.initialDelaySeconds ?? 0,
					`${object.rel} ${name} initialDelaySeconds`,
					object.rel
				);
			} else {
				ok('3.9', !rendered, `${object.rel} renders no ${name} probe (the App spec declares none)`, object.rel);
			}
		}
		if (component.role === 'web' && !declared.startup) {
			eq('3.10', container.startupProbe?.periodSeconds, 10, `${object.rel} default startup period`, object.rel);
			eq(
				'3.11',
				container.startupProbe?.failureThreshold,
				60,
				`${object.rel} default startup threshold`,
				object.rel
			);
		}
	}

	/* -- 4 ── multi-step job order --------------------------------------------------------------- */
	suite(`${id} · 4 · jobs`, 'one Job per spec.jobs[], in declared order, phases in the spec’s order');
	const jobFiles = yourCluster.filter((o) => o.doc?.kind === 'Job').sort((a, b) => (a.rel < b.rel ? -1 : 1));
	eq('4.1', jobFiles.length, (spec.jobs ?? []).length, `${id} Job count`, `${id}/your-cluster/5*-job-*.yaml`);
	(spec.jobs ?? []).forEach((job, index) => {
		const expectedName = `job-${job.name}-${pin.deploymentShort}`;
		const object = jobFiles[index];
		if (
			!ok(
				'4.2',
				Boolean(object),
				`Job #${index} (${job.name}) is rendered`,
				`${id}/your-cluster/5${index}-job-${job.name}.yaml`
			)
		)
			return;
		eq('4.3', object.rel, `${id}/your-cluster/5${index}-job-${job.name}.yaml`, `Job #${index} file`, object.rel);
		eq('4.4', object.doc.metadata?.name, expectedName, `${object.rel} metadata.name`, object.rel);
		eq(
			'4.5',
			object.doc.metadata?.labels?.['ever-works.io/job'],
			job.name,
			`${object.rel} ever-works.io/job`,
			object.rel
		);
		eq(
			'4.6',
			object.doc.metadata?.labels?.['ever-works.io/component'],
			job.component ?? spec.domains.primaryComponent,
			`${object.rel} component label`,
			object.rel
		);
		eq(
			'4.7',
			object.doc.spec?.activeDeadlineSeconds,
			job.timeoutSeconds ?? 600,
			`${object.rel} activeDeadlineSeconds (spec.jobs[${index}].timeoutSeconds)`,
			object.rel
		);
		const container = object.doc.spec?.template?.spec?.containers?.[0];
		eq('4.8', container?.name, job.name, `${object.rel} container name`, object.rel);
		ok(
			'4.9',
			JSON.stringify(container?.command) === JSON.stringify(job.command),
			`${object.rel} command is spec.jobs[${index}].command verbatim (got ${show(container?.command)})`,
			object.rel
		);
		eq('4.10', object.doc.spec?.template?.spec?.restartPolicy, 'Never', `${object.rel} restartPolicy`, object.rel);
		eq(
			'4.11',
			object.doc.spec?.ttlSecondsAfterFinished,
			86400,
			`${object.rel} ttlSecondsAfterFinished`,
			object.rel
		);
	});
	const phases = jobFiles.map((object) => {
		const job = spec.jobs.find(
			(candidate) => `job-${candidate.name}-${pin.deploymentShort}` === object.doc.metadata.name
		);
		return job?.when;
	});
	const phaseRank = { 'pre-deploy': 0, 'post-deploy': 1, 'first-deploy': 2 };
	ok(
		'4.12',
		phases.every((phase, index) => index === 0 || phaseRank[phases[index - 1]] <= phaseRank[phase]),
		`Job phases are ordered pre-deploy → first-deploy (got ${phases.join(' → ')}); first-deploy runs before the Ingress is published`,
		`${id}/your-cluster/5*-job-*.yaml`
	);
	ok(
		'4.13',
		JSON.stringify(phases) === JSON.stringify((spec.jobs ?? []).map((job) => job.when)),
		`Job phases follow spec.jobs[] order exactly (spec: ${(spec.jobs ?? []).map((j) => j.when).join(', ')})`,
		`${id}/your-cluster/5*-job-*.yaml`
	);
	for (const name of ['smoke', 'hairpin', 'isolation-probe']) {
		ok(
			'4.14',
			!yourCluster.some((o) => o.doc?.kind === 'Job' && o.doc.metadata.name.includes(name)),
			`no ${name} Job is in the desired-state set (rendered by app-deployer at deploy time, APW-06 plan §4.11/§4.12)`,
			`${id}/your-cluster/`
		);
	}

	/* -- 5 ── cron schedules and their auth scheme ---------------------------------------------- */
	suite(`${id} · 5 · cron`, 'one CronJob per spec.cron[], with the spec’s schedule and auth scheme');
	const cronFiles = yourCluster.filter((o) => o.doc?.kind === 'CronJob').sort((a, b) => (a.rel < b.rel ? -1 : 1));
	eq(
		'5.1',
		cronFiles.length,
		(spec.cron ?? []).length,
		`${id} CronJob count`,
		`${id}/your-cluster/6*-cronjob-*.yaml`
	);
	const runnerRequests = runnerRequestList(yourCluster);
	(spec.cron ?? []).forEach((cron, index) => {
		const object = cronFiles[index];
		if (
			!ok(
				'5.2',
				Boolean(object),
				`CronJob #${index} (${cron.name}) is rendered`,
				`${id}/your-cluster/6${index}-cronjob-${cron.name}.yaml`
			)
		)
			return;
		eq('5.3', object.doc.metadata?.name, `cron-${cron.name}`, `${object.rel} metadata.name`, object.rel);
		eq(
			'5.4',
			object.doc.spec?.schedule,
			cron.schedule,
			`${object.rel} schedule (spec.cron[${index}].schedule)`,
			object.rel
		);
		eq('5.5', object.doc.spec?.timeZone, 'Etc/UTC', `${object.rel} timeZone`, object.rel);
		eq(
			'5.6',
			object.doc.spec?.concurrencyPolicy,
			(cron.concurrency ?? 'forbid') === 'allow' ? 'Allow' : 'Forbid',
			`${object.rel} concurrencyPolicy`,
			object.rel
		);
		eq('5.7', object.doc.spec?.startingDeadlineSeconds, 300, `${object.rel} startingDeadlineSeconds`, object.rel);
		eq(
			'5.8',
			object.doc.spec?.successfulJobsHistoryLimit,
			1,
			`${object.rel} successfulJobsHistoryLimit`,
			object.rel
		);
		eq('5.9', object.doc.spec?.failedJobsHistoryLimit, 3, `${object.rel} failedJobsHistoryLimit`, object.rel);
		eq('5.10', object.doc.spec?.suspend, false, `${object.rel} suspend`, object.rel);
		const template = object.doc.spec?.jobTemplate?.spec?.template;
		const mounts = template?.spec?.volumes ?? [];
		ok(
			'5.11',
			mounts.some((volume) => volume.configMap),
			`${object.rel} runs the runner (a ConfigMap is mounted) — APW-06 plan §4.9: an \`http\` cron is a runner job`,
			object.rel
		);
		const request = runnerRequests.find((entry) => entry.name === cron.name && entry.kind === 'cron');
		if (ok('5.12', Boolean(request), `${object.rel} appears in the runner request list`, object.rel)) {
			eq('5.13', request.path, cron.http.path, `${object.rel} runner path`, object.rel);
			eq('5.14', request.method, cron.http.method ?? 'GET', `${object.rel} runner method`, object.rel);
			eq('5.15', request.authEnv, cron.http.authEnv ?? null, `${object.rel} runner authEnv`, object.rel);
			eq(
				'5.16',
				request.authScheme,
				cron.http.authScheme ?? 'bearer',
				`${object.rel} runner authScheme (spec md §4.8: bearer → \`Authorization: Bearer <v>\`, raw → \`Authorization: <v>\`)`,
				object.rel
			);
			ok(
				'5.17',
				secretKeys(yourCluster).includes(request.authEnv),
				`${object.rel} authEnv \`${request.authEnv}\` is a key of the env Secret (never a literal)`,
				object.rel
			);
		}
	});
	if ((spec.cron ?? []).length === 0) {
		ok('5.18', cronFiles.length === 0, `${id} declares no cron, so no CronJob is rendered`, `${id}/your-cluster/`);
	}

	/* -- 6 ── the runtime-versus-build env split ------------------------------------------------- */
	suite(`${id} · 6 · env split`, 'build-time names never reach the runtime Secret, and vice versa');
	const runtimeEntries = spec.env.filter((entry) => (entry.phase ?? 'runtime') !== 'build');
	const buildOnly = spec.env.filter((entry) => (entry.phase ?? 'runtime') === 'build').map((entry) => entry.name);
	const secret = clusterKind('Secret', `app-env-${envChecksum(bp).slice(0, 10)}`);
	const secretWhere = `${id}/your-cluster/04-secret-env.yaml`;
	if (
		ok('6.1', Boolean(secret), `the env Secret (app-env-${envChecksum(bp).slice(0, 10)}) is rendered`, secretWhere)
	) {
		const keys = Object.keys(secret.doc.stringData ?? {});
		eq('6.2', keys.length, runtimeEntries.length, `${secretWhere} key count`, secretWhere);
		for (const entry of runtimeEntries) {
			ok(
				'6.3',
				keys.includes(entry.name),
				`${secretWhere} carries \`${entry.name}\` (phase ${entry.phase ?? 'runtime'})`,
				secretWhere
			);
		}
		for (const name of buildOnly) {
			ok('6.4', !keys.includes(name), `${secretWhere} does NOT carry build-only \`${name}\``, secretWhere);
		}
		eq('6.5', secret.doc.immutable, true, `${secretWhere} immutable`, secretWhere);
		eq('6.6', secret.doc.type, 'Opaque', `${secretWhere} type`, secretWhere);
	}
	const buildArgNames = (spec.build.args ?? []).map((argument) => argument.name);
	for (const argument of spec.build.args ?? []) {
		if (argument.fromEnv === undefined) continue;
		const entry = spec.env.find((candidate) => candidate.name === argument.fromEnv);
		ok(
			'6.7',
			entry && (entry.phase ?? 'runtime') !== 'runtime',
			`build.args[].fromEnv \`${argument.fromEnv}\` names an env entry with phase build/both`,
			bp.file
		);
		const workflow = golden.objects.find((o) => o.rel.endsWith('ever-works-build.yml'));
		if (workflow && entry) {
			ok(
				'6.8',
				workflow.text.includes(`EW_${argument.fromEnv}`),
				`${workflow.rel} exposes \`EW_${argument.fromEnv}\` as a build value`,
				workflow.rel
			);
		}
	}
	for (const name of buildArgNames) {
		const entry = spec.env.find((candidate) => candidate.name === name);
		if (!entry) continue;
		ok(
			'6.9',
			(entry.phase ?? 'runtime') !== 'runtime',
			`build arg \`${name}\` names an env entry with phase build/both, never a runtime-only one`,
			bp.file
		);
	}
	const configMap = clusterKind('ConfigMap', `app-platform-${envChecksum(bp).slice(0, 10)}`);
	const configWhere = `${id}/your-cluster/03-configmap-platform.yaml`;
	if (ok('6.10', Boolean(configMap), 'the platform ConfigMap is rendered', configWhere)) {
		const keys = Object.keys(configMap.doc.data ?? {});
		for (const key of keys) {
			ok(
				'6.11',
				key.startsWith('EVER_WORKS_') && !key.startsWith('EVER_WORKS_SOURCE_URL'),
				`${configWhere} key \`${key}\` is a platform-injected EVER_WORKS_* variable`,
				configWhere
			);
		}
		const required = [
			'EVER_WORKS_APP_HOST',
			'EVER_WORKS_APP_URL',
			'EVER_WORKS_APP_COMMIT',
			'EVER_WORKS_DEPLOYMENT_ID'
		];
		for (const key of required) {
			ok('6.12', keys.includes(key), `${configWhere} carries \`${key}\``, configWhere);
		}
		eq(
			'6.13',
			configMap.doc.data?.EVER_WORKS_APP_HOST,
			pin.primaryHost,
			`${configWhere} EVER_WORKS_APP_HOST`,
			configWhere
		);
		eq(
			'6.14',
			configMap.doc.data?.EVER_WORKS_APP_COMMIT,
			pin.specCommitSha,
			`${configWhere} EVER_WORKS_APP_COMMIT`,
			configWhere
		);
		ok(
			'6.15',
			!keys.includes('EVER_WORKS_SOURCE_URL'),
			`${configWhere} omits EVER_WORKS_SOURCE_URL (FR-44: the licence class does not require offering source)`,
			configWhere
		);
	}
	for (const object of yourCluster.filter((o) => o.doc?.kind === 'Deployment')) {
		const sources = object.doc.spec.template.spec.containers[0].envFrom ?? [];
		const secretRef = sources.find((entry) => entry.secretRef)?.secretRef;
		const configRef = sources.find((entry) => entry.configMapRef)?.configMapRef;
		if (ok('6.16', Boolean(secretRef && configRef), `${object.rel} has both env sources`, object.rel)) {
			eq(
				'6.17',
				secretRef.optional,
				false,
				`${object.rel} secretRef.optional (a missing Secret must fail loudly)`,
				object.rel
			);
			eq('6.18', configRef.optional, false, `${object.rel} configMapRef.optional`, object.rel);
			eq(
				'6.19',
				secretRef.name,
				`app-env-${envChecksum(bp).slice(0, 10)}`,
				`${object.rel} secretRef.name`,
				object.rel
			);
		}
		eq(
			'6.20',
			object.doc.spec.template.metadata.annotations?.['ever-works.io/env-checksum'],
			envChecksum(bp).slice(0, 16),
			`${object.rel} ever-works.io/env-checksum`,
			object.rel
		);
	}
	const appEnvNames = new Set(spec.env.map((entry) => entry.name));
	const literalEnv = [];
	for (const object of yourCluster.filter((o) => ['Deployment', 'Job', 'CronJob'].includes(o.doc?.kind))) {
		const pods = [object.doc.spec?.template, object.doc.spec?.jobTemplate?.spec?.template].filter(Boolean);
		for (const pod of pods) {
			for (const container of pod.spec?.containers ?? []) {
				for (const variable of container.env ?? []) {
					if (variable.value !== undefined && appEnvNames.has(variable.name)) {
						literalEnv.push(`${object.rel} ${container.name}.${variable.name}`);
					}
				}
			}
		}
	}
	ok(
		'6.21',
		literalEnv.length === 0,
		`no App env VALUE is written into a workload spec — they arrive by envFrom (APW-06 plan §4.3, ACCEPTANCE E2E-05)${literalEnv.length ? `; found ${literalEnv.slice(0, 3).join(', ')}` : ''}`,
		`${id}/your-cluster/`
	);

	/* -- 7 ── the platform’s labels -------------------------------------------------------------- */
	suite(`${id} · 7 · labels`, 'every object carries the platform’s labels, and none of the forbidden ones');
	for (const object of yourCluster) {
		const labels = object.doc?.metadata?.labels ?? {};
		eq(
			'7.1',
			labels['app.kubernetes.io/managed-by'],
			'ever-works-k8s-plugin',
			`${object.rel} managed-by`,
			object.rel
		);
		eq('7.2', labels['app.kubernetes.io/part-of'], pin.slug, `${object.rel} part-of`, object.rel);
		eq('7.3', labels['ever-works.io/work-id'], pin.workId, `${object.rel} work-id`, object.rel);
		eq('7.4', labels['ever-works.io/kind'], 'app', `${object.rel} kind`, object.rel);
		ok(
			'7.5',
			labels['ever-works.io/managed'] === undefined,
			`${object.rel} carries no ever-works.io/managed label`,
			object.rel
		);
		ok(
			'7.6',
			labels['app.kubernetes.io/name'] === undefined,
			`${object.rel} carries no app.kubernetes.io/name label`,
			object.rel
		);
		const componentLabel = labels['ever-works.io/component'];
		if (componentLabel !== undefined) {
			ok(
				'7.7',
				spec.components.some((component) => component.name === componentLabel),
				`${object.rel} ever-works.io/component \`${componentLabel}\` names a component of the App spec`,
				object.rel
			);
		}
	}
	const namespace = clusterKind('Namespace');
	if (ok('7.8', Boolean(namespace), 'the Namespace is rendered', `${id}/your-cluster/00-namespace.yaml`)) {
		eq('7.9', namespace.doc.metadata.name, pin.namespace, 'Namespace name', namespace.rel);
		eq(
			'7.10',
			namespace.doc.metadata.labels['pod-security.kubernetes.io/enforce'],
			'baseline',
			'Namespace enforce level',
			namespace.rel
		);
		eq(
			'7.11',
			namespace.doc.metadata.labels['pod-security.kubernetes.io/warn'],
			'restricted',
			'Namespace warn level',
			namespace.rel
		);
		eq(
			'7.12',
			namespace.doc.metadata.labels['pod-security.kubernetes.io/audit'],
			'restricted',
			'Namespace audit level',
			namespace.rel
		);
	}
	const serviceAccount = clusterKind('ServiceAccount');
	if (
		ok(
			'7.13',
			Boolean(serviceAccount),
			'the ServiceAccount `app` is rendered',
			`${id}/your-cluster/01-serviceaccount.yaml`
		)
	) {
		eq('7.14', serviceAccount.doc.metadata.name, 'app', 'ServiceAccount name', serviceAccount.rel);
		eq(
			'7.15',
			serviceAccount.doc.automountServiceAccountToken,
			false,
			'ServiceAccount automountServiceAccountToken',
			serviceAccount.rel
		);
	}
	for (const object of yourCluster.filter((o) => o.doc?.kind === 'Deployment')) {
		eq(
			'7.16',
			object.doc.spec.template.spec.serviceAccountName,
			'app',
			`${object.rel} serviceAccountName`,
			object.rel
		);
		eq(
			'7.17',
			object.doc.spec.template.spec.automountServiceAccountToken,
			false,
			`${object.rel} automountServiceAccountToken`,
			object.rel
		);
		eq(
			'7.18',
			object.doc.spec.template.spec.enableServiceLinks,
			false,
			`${object.rel} enableServiceLinks`,
			object.rel
		);
		const security = object.doc.spec.template.spec.securityContext ?? {};
		eq('7.19', security.runAsNonRoot, true, `${object.rel} runAsNonRoot`, object.rel);
		eq('7.20', security.seccompProfile?.type, 'RuntimeDefault', `${object.rel} seccompProfile`, object.rel);
		const containerSecurity = object.doc.spec.template.spec.containers[0].securityContext ?? {};
		eq(
			'7.21',
			containerSecurity.allowPrivilegeEscalation,
			false,
			`${object.rel} allowPrivilegeEscalation`,
			object.rel
		);
		eq('7.22', containerSecurity.capabilities?.drop?.[0], 'ALL', `${object.rel} capabilities.drop`, object.rel);
		const component = spec.components.find((c) => c.name === object.doc.metadata.name);
		eq(
			'7.23',
			containerSecurity.readOnlyRootFilesystem,
			!(component.writableRootFilesystem ?? false),
			`${object.rel} readOnlyRootFilesystem`,
			object.rel
		);
	}

	/* -- 8 ── a default-deny network policy is present ------------------------------------------- */
	suite(`${id} · 8 · network policies`, 'deny-all is present and the other four follow §4.10');
	const policies = yourCluster.filter((o) => o.doc?.kind === 'NetworkPolicy');
	const policy = (name) => policies.find((o) => o.doc.metadata.name === name);
	const deny = policy('ew-default-deny');
	if (
		ok(
			'8.1',
			Boolean(deny),
			'a default-deny NetworkPolicy is present',
			`${id}/your-cluster/30-networkpolicy-ew-default-deny.yaml`
		)
	) {
		eq('8.2', JSON.stringify(deny.doc.spec.podSelector), '{}', `${deny.rel} podSelector (all pods)`, deny.rel);
		eq(
			'8.3',
			JSON.stringify(deny.doc.spec.policyTypes),
			'["Ingress","Egress"]',
			`${deny.rel} policyTypes`,
			deny.rel
		);
		ok(
			'8.4',
			deny.doc.spec.ingress === undefined && deny.doc.spec.egress === undefined,
			`${deny.rel} carries no rules (deny all)`,
			deny.rel
		);
	}
	for (const name of ['ew-allow-same-namespace', 'ew-allow-ingress', 'ew-allow-egress', 'ew-allow-deps']) {
		ok(
			'8.5',
			Boolean(policy(name)),
			`NetworkPolicy \`${name}\` is present`,
			`${id}/your-cluster/3*-networkpolicy-${name}.yaml`
		);
	}
	const ingressPolicy = policy('ew-allow-ingress');
	const primary = spec.components.find((component) => component.name === spec.domains.primaryComponent);
	if (ingressPolicy) {
		eq(
			'8.6',
			ingressPolicy.doc.spec.podSelector?.matchLabels?.['ever-works.io/component'],
			primary.name,
			`${ingressPolicy.rel} targets the primary web component`,
			ingressPolicy.rel
		);
		eq(
			'8.7',
			ingressPolicy.doc.spec.ingress?.[0]?.ports?.[0]?.port,
			primary.port,
			`${ingressPolicy.rel} allowed port`,
			ingressPolicy.rel
		);
	}
	const egressPolicy = policy('ew-allow-egress');
	if (egressPolicy) {
		const blocks = JSON.stringify(egressPolicy.doc.spec.egress);
		for (const cidr of [
			'10.0.0.0/8',
			'172.16.0.0/12',
			'192.168.0.0/16',
			'100.64.0.0/10',
			'169.254.0.0/16',
			'127.0.0.0/8',
			'0.0.0.0/8',
			'224.0.0.0/4',
			'240.0.0.0/4'
		]) {
			ok(
				'8.8',
				blocks.includes(cidr),
				`${egressPolicy.rel} excludes ${cidr} from internet egress`,
				egressPolicy.rel
			);
		}
		for (const cidr of ['fc00::/7', 'fe80::/10', '::1/128', 'ff00::/8']) {
			ok('8.9', blocks.includes(cidr), `${egressPolicy.rel} excludes ${cidr} from IPv6 egress`, egressPolicy.rel);
		}
		ok(
			'8.10',
			blocks.includes('53') && blocks.includes('UDP') && blocks.includes('kube-dns'),
			`${egressPolicy.rel} allows DNS`,
			egressPolicy.rel
		);
	}
	const depsPolicy = policy('ew-allow-deps');
	if (depsPolicy) {
		const hairpinRules = (depsPolicy.doc.spec.egress ?? []).filter((rule) =>
			(rule.ports ?? []).some((port) => port.port === 80 || port.port === 443)
		);
		eq(
			'8.11',
			hairpinRules.length > 0,
			spec.domains.needsHairpin === true,
			`${depsPolicy.rel} hairpin rule present iff domains.needsHairpin (spec: ${spec.domains.needsHairpin === true})`,
			depsPolicy.rel
		);
	}

	/* -- 9 ── images: never `latest`, always a digest -------------------------------------------- */
	suite(`${id} · 9 · images`, 'no `latest` tag anywhere; every workload pins a digest');
	for (const object of golden.objects) {
		for (const field of imageFields(object.doc)) {
			ok(
				'9.1',
				!/:latest(\s|$|@)/.test(field.value),
				`${object.rel}${field.pointer} is not \`:latest\``,
				object.rel
			);
		}
	}
	for (const object of yourCluster.filter((o) => o.doc?.kind === 'Deployment')) {
		const image = object.doc.spec.template.spec.containers[0].image;
		ok(
			'9.2',
			/@sha256:[0-9a-f]{64}$/.test(image),
			`${object.rel} container image is digest-pinned (${image})`,
			object.rel
		);
		eq(
			'9.3',
			object.doc.spec.template.spec.containers[0].imagePullPolicy,
			'IfNotPresent',
			`${object.rel} imagePullPolicy`,
			object.rel
		);
		ok(
			'9.4',
			(object.doc.spec.template.spec.imagePullSecrets ?? []).some((entry) => entry.name === 'app-pull'),
			`${object.rel} pulls with the App-Work-scoped credential`,
			object.rel
		);
	}
	const pullSecret = clusterKind('Secret', 'app-pull');
	ok('9.5', Boolean(pullSecret), 'the pull Secret `app-pull` is rendered', `${id}/your-cluster/05-secret-pull.yaml`);
	for (const object of yourCluster.filter((o) => o.doc?.kind === 'CronJob')) {
		const image = object.doc.spec.jobTemplate.spec.template.spec.containers[0].image;
		ok(
			'9.6',
			isPlaceholder(image) || /@sha256:[0-9a-f]{64}$/.test(image),
			`${object.rel} runner image is digest-pinned or the documented placeholder (${image})`,
			object.rel
		);
	}

	/* -- 10 ── no literal secret value anywhere -------------------------------------------------- */
	suite(`${id} · 10 · secrets`, 'every secret is a reference or a generated placeholder');
	const secretShapes = [
		[/sk_live_|sk_test_/, 'a Stripe-style key'],
		[/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/, 'a GitHub token'],
		[/AKIA[0-9A-Z]{16}/, 'an AWS access key id'],
		[/xox[baprs]-/, 'a Slack token'],
		[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
		[/cfat_[A-Za-z0-9_-]{20,}/, 'a Cloudflare token']
	];
	for (const object of golden.objects) {
		for (const [pattern, what] of secretShapes) {
			ok('10.1', !pattern.test(object.text), `${object.rel} contains no ${what}`, object.rel);
		}
		const lines = object.text.split('\n');
		lines.forEach((line, index) => {
			// Only ENV-VAR-shaped names: `automountServiceAccountToken`, `secretName` and the
			// `password:` lines inside a JS block scalar are not env values and must not match.
			const match = /^\s*([A-Z][A-Z0-9_]{2,})\s*:\s*(.+)$/.exec(line);
			if (!match) return;
			if (!/(PASSWORD|SECRET|TOKEN|_KEY|APIKEY|CREDENTIAL)/.test(match[1])) return;
			const value = match[2]
				.replace(/\s+#.*$/, '')
				.trim()
				.replace(/^["']|["']$/g, '');
			if (value === '' || value === 'null' || value.startsWith('#')) return;
			if (value.includes('${{')) return; // a GitHub Actions expression, i.e. a reference
			if (/^(valueFrom|secretKeyRef|configMapKeyRef|secretRef|configMapRef)$/.test(value)) return;
			// BUILD_SERVICE_DEFAULTS (APW-05 plan.md:816-829): throwaway, non-secret by construction.
			if (BUILD_SERVICE_DEFAULT_LITERALS.has(value)) return;
			ok(
				'10.2',
				isPlaceholder(value),
				`${object.rel}:${index + 1} \`${match[1]}\` holds a literal value ${show(value)} — every secret must be a reference or a placeholder`,
				`${object.rel}:${index + 1}`
			);
		});
	}
	if (secret) {
		for (const [name, value] of Object.entries(secret.doc.stringData ?? {})) {
			const entry = spec.env.find((candidate) => candidate.name === name);
			const literal = envValueOf(entry);
			if (literal !== undefined) {
				eq(
					'10.3',
					value,
					literal,
					`${secretWhere} ${name} (a non-secret literal the Blueprint states)`,
					secretWhere
				);
			} else {
				ok(
					'10.4',
					isPlaceholder(value) || value === specEnvValue(entry, bp),
					`${secretWhere} ${name} is a placeholder or the documented derived value — got ${show(value)} (its env entry is secret, generated, prompted or derived)`,
					secretWhere
				);
			}
		}
	}
	const work = golden.objects.find((o) => o.rel.endsWith('ever-works-apps/work.yaml'));
	if (work) {
		ok(
			'10.5',
			isPlaceholder(work.doc.spec?.env?.sealed),
			`${work.rel} spec.env.sealed is a sealed placeholder, never plaintext`,
			work.rel
		);
		eq(
			'10.6',
			JSON.stringify(Object.keys(work.doc.spec?.env ?? {}).sort()),
			JSON.stringify(['names', 'sealed']),
			`${work.rel} spec.env has exactly \`sealed\` and \`names\``,
			work.rel
		);
	}

	/* -- 11 ── the managed tier’s desired state -------------------------------------------------- */
	suite(`${id} · 11 · the Work resource`, 'the tier receives desired state, not objects');
	if (ok('11.1', Boolean(work), 'ever-works-apps/work.yaml exists', `${id}/ever-works-apps/work.yaml`)) {
		eq('11.2', work.doc.apiVersion, 'hosting.ever.works/v1alpha1', `${work.rel} apiVersion`, work.rel);
		eq('11.3', work.doc.kind, 'Work', `${work.rel} kind`, work.rel);
		eq('11.4', work.doc.metadata?.name, `w-${pin.workId}`, `${work.rel} metadata.name`, work.rel);
		eq('11.5', work.doc.metadata?.namespace, 'ever-works-apps-control', `${work.rel} metadata.namespace`, work.rel);
		eq(
			'11.6',
			work.doc.metadata?.labels?.['hosting.ever.works/owner'],
			pin.ownerUserId,
			`${work.rel} owner label`,
			work.rel
		);
		eq(
			'11.7',
			work.doc.metadata?.labels?.['hosting.ever.works/canary'],
			'false',
			`${work.rel} canary label`,
			work.rel
		);
		eq('11.8', work.doc.spec?.workId, pin.workId, `${work.rel} spec.workId`, work.rel);
		eq('11.9', work.doc.spec?.desiredState, 'running', `${work.rel} spec.desiredState`, work.rel);
		ok('11.10', work.doc.spec?.dataDeletion === null, `${work.rel} spec.dataDeletion is null`, work.rel);
		eq('11.11', work.doc.spec?.egressThrottle, false, `${work.rel} spec.egressThrottle`, work.rel);
		ok(
			'11.12',
			Number.isInteger(work.doc.spec?.generation) && work.doc.spec.generation >= 1,
			`${work.rel} spec.generation is a positive integer`,
			work.rel
		);
		ok(
			'11.13',
			typeof work.doc.spec?.quotaProfile === 'string' && work.doc.spec.quotaProfile.length > 0,
			`${work.rel} spec.quotaProfile is set`,
			work.rel
		);
		const workComponents = work.doc.spec?.components ?? [];
		eq('11.14', workComponents.length, spec.components.length, `${work.rel} component count`, work.rel);
		spec.components.forEach((component, index) => {
			const rendered = workComponents[index] ?? {};
			eq('11.15', rendered.name, component.name, `${work.rel} components[${index}].name`, work.rel);
			eq('11.16', rendered.role, component.role, `${work.rel} components[${index}].role`, work.rel);
			eq('11.17', rendered.port, component.port, `${work.rel} components[${index}].port`, work.rel);
			eq(
				'11.18',
				rendered.replicas,
				component.replicas ?? 1,
				`${work.rel} components[${index}].replicas`,
				work.rel
			);
			ok(
				'11.19',
				JSON.stringify(rendered.command) === JSON.stringify(component.command),
				`${work.rel} components[${index}].command is the App spec’s`,
				work.rel
			);
		});
		const workJobs = work.doc.spec?.jobs ?? [];
		eq('11.20', workJobs.length, (spec.jobs ?? []).length, `${work.rel} job count`, work.rel);
		(spec.jobs ?? []).forEach((job, index) => {
			eq('11.21', workJobs[index]?.name, job.name, `${work.rel} jobs[${index}].name`, work.rel);
			eq('11.22', workJobs[index]?.when, job.when, `${work.rel} jobs[${index}].when`, work.rel);
			eq(
				'11.23',
				workJobs[index]?.timeoutSeconds,
				job.timeoutSeconds ?? 600,
				`${work.rel} jobs[${index}].timeoutSeconds`,
				work.rel
			);
		});
		const workCron = work.doc.spec?.cron ?? [];
		eq('11.24', workCron.length, (spec.cron ?? []).length, `${work.rel} cron count`, work.rel);
		(spec.cron ?? []).forEach((cron, index) => {
			eq('11.25', workCron[index]?.schedule, cron.schedule, `${work.rel} cron[${index}].schedule`, work.rel);
			eq('11.26', workCron[index]?.http?.path, cron.http.path, `${work.rel} cron[${index}].http.path`, work.rel);
			eq(
				'11.27',
				workCron[index]?.http?.method,
				cron.http.method ?? 'GET',
				`${work.rel} cron[${index}].http.method`,
				work.rel
			);
			eq(
				'11.28',
				workCron[index]?.http?.authEnv,
				cron.http.authEnv ?? null,
				`${work.rel} cron[${index}].http.authEnv`,
				work.rel
			);
			eq(
				'11.29',
				workCron[index]?.http?.authScheme,
				cron.http.authScheme ?? 'bearer',
				`${work.rel} cron[${index}].http.authScheme — the Work shape carries it (APW-10 plan.md:249, CONTRACTS C2)`,
				work.rel
			);
		});
		const workImages = work.doc.spec?.images ?? [];
		ok('11.30', workImages.length >= 1, `${work.rel} spec.images is non-empty`, work.rel);
		for (const image of workImages) {
			ok(
				'11.31',
				/@sha256:[0-9a-f]{64}$/.test(image.source ?? ''),
				`${work.rel} images[${image.component}].source is digest-pinned (${image.source})`,
				work.rel
			);
			ok(
				'11.32',
				spec.components.some((component) => component.name === image.component),
				`${work.rel} images[].component \`${image.component}\` names a component`,
				work.rel
			);
		}
		eq(
			'11.33',
			JSON.stringify(work.doc.spec?.hosts),
			JSON.stringify([{ host: pin.primaryHost, kind: 'managed', customHostnameRef: null }]),
			`${work.rel} spec.hosts`,
			work.rel
		);
		eq(
			'11.34',
			JSON.stringify(work.doc.spec?.env?.names),
			JSON.stringify(runtimeEntries.map((entry) => entry.name)),
			`${work.rel} spec.env.names`,
			work.rel
		);
		for (const dependency of work.doc.spec?.dependencies ?? []) {
			ok(
				'11.35',
				['postgres', 'redis', 'objectStorage', 'smtp'].includes(dependency.kind),
				`${work.rel} dependencies[].kind \`${dependency.kind}\` is inside the Work shape (APW-10 plan.md:253)`,
				work.rel
			);
		}
		for (const kind of ['postgres', 'smtp']) {
			if (!spec.dependencies?.[kind]) continue;
			ok(
				'11.36',
				(work.doc.spec?.dependencies ?? []).some((dependency) => dependency.kind === kind),
				`${work.rel} carries the App spec’s ${kind} dependency`,
				work.rel
			);
		}
		const workSmoke = work.doc.spec?.smoke ?? [];
		eq('11.38', workSmoke.length, (spec.smoke ?? []).length, `${work.rel} spec.smoke count`, work.rel);
		(spec.smoke ?? []).forEach((smoke, index) => {
			eq('11.39', workSmoke[index]?.name, smoke.name, `${work.rel} smoke[${index}].name`, work.rel);
			eq('11.40', workSmoke[index]?.path, smoke.http.path, `${work.rel} smoke[${index}].path`, work.rel);
			eq(
				'11.41',
				workSmoke[index]?.method,
				smoke.http.method ?? 'GET',
				`${work.rel} smoke[${index}].method`,
				work.rel
			);
		});
		ok(
			'11.42',
			work.doc.spec?.pausedReplicas === null,
			`${work.rel} spec.pausedReplicas is null for a running Work (APW-10 plan.md:237)`,
			work.rel
		);
		for (const kind of ['Deployment', 'Service', 'Ingress', 'Namespace', 'Secret', 'CronJob']) {
			ok(
				'11.37',
				work.doc.kind !== kind,
				`${work.rel} contains no ${kind} — the platform applies no object on this target (R-5)`,
				work.rel
			);
		}
	}

	/* -- 12 ── the build workflow ---------------------------------------------------------------- */
	suite(
		`${id} · 12 · the build workflow`,
		'the written file matches the generator’s contract, or is correctly absent'
	);
	const workflow = golden.objects.find((o) => o.rel.endsWith('ever-works-build.yml'));
	const buildStrategy = spec.build.strategy;
	const checks = spec.checks ?? [];
	const shouldBeAbsent = (buildStrategy === 'image' || buildStrategy === 'none') && checks.length === 0;
	if (ok('12.1', Boolean(workflow), `${id}/ever-works-build.yml exists`, `${id}/ever-works-build.yml`)) {
		if (shouldBeAbsent) {
			ok(
				'12.2',
				workflow.text.includes('# ever-works-golden: absent-file'),
				`${workflow.rel} declares the file is NOT written (strategy \`${buildStrategy}\` with no checks, APW-05 plan §4.6 step 8)`,
				workflow.rel
			);
			ok('12.3', !/^jobs:/m.test(workflow.text), `${workflow.rel} carries no jobs`, workflow.rel);
		} else {
			const header = workflow.text.split('\n').find((line) => line.startsWith('# ever-works-build '));
			ok(
				'12.4',
				/^# ever-works-build generator=1 inputs=sha256:[0-9a-f]{64}$/.test(header ?? ''),
				`${workflow.rel} header line is \`# ever-works-build generator=1 inputs=sha256:<64 hex>\` (CONTRACTS §9), got ${show(header)}`,
				workflow.rel
			);
			const doc = parseYaml(workflow.text).value;
			eq('12.5', doc.name, 'Ever Works build', `${workflow.rel} name`, workflow.rel);
			eq(
				'12.6',
				JSON.stringify(Object.keys(doc.permissions ?? {})),
				'[]',
				`${workflow.rel} top-level permissions is empty`,
				workflow.rel
			);
			eq('12.7', doc.on?.push?.branches?.[0], spec.source.branch, `${workflow.rel} push branch`, workflow.rel);
			eq(
				'12.8',
				doc.on?.pull_request?.branches?.[0],
				spec.source.branch,
				`${workflow.rel} pull_request branch`,
				workflow.rel
			);
			eq(
				'12.9',
				JSON.stringify(Object.keys(doc.on?.workflow_dispatch?.inputs ?? {})),
				JSON.stringify(['ew_build_id', 'ew_sha', 'ew_mode', 'ew_verify_plan', 'ew_reuse_digest']),
				`${workflow.rel} workflow_dispatch inputs (APW-05 plan.md §2.4)`,
				workflow.rel
			);
			const build = doc.jobs?.build;
			if (buildStrategy === 'dockerfile') {
				if (ok('12.10', Boolean(build), `${workflow.rel} has a \`build\` job`, workflow.rel)) {
					eq(
						'12.11',
						build['timeout-minutes'],
						spec.build.resources.timeoutMinutes,
						`${workflow.rel} build timeout-minutes — APW-05 plan.md §2.4:181 keeps \`build.resources.timeoutMinutes\` exactly; only the \`verify\` job adds 30`,
						workflow.rel
					);
					eq(
						'12.12',
						build.permissions?.contents === 'read' && build.permissions?.packages === 'write',
						true,
						`${workflow.rel} build permissions`,
						workflow.rel
					);
					const uses = build.steps.filter((step) => typeof step.uses === 'string').map((step) => step.uses);
					for (const [name, pinned] of Object.entries({
						checkout: 'actions/checkout@',
						setupBuildx: 'docker/setup-buildx-action@',
						login: 'docker/login-action@',
						buildPush: 'docker/build-push-action@',
						uploadArtifact: 'actions/upload-artifact@'
					})) {
						const found = uses.find((entry) => entry.startsWith(pinned));
						ok('12.13', Boolean(found), `${workflow.rel} uses ${pinned} (pin: ${name})`, workflow.rel);
						if (found) {
							const sha = found.slice(pinned.length).split(' ')[0];
							ok(
								'12.14',
								/^[0-9a-f]{40}$/.test(sha),
								`${workflow.rel} ${name} is pinned to a 40-hex commit (${sha})`,
								workflow.rel
							);
						}
					}
					const buildPush = build.steps.find((step) =>
						String(step.uses ?? '').startsWith('docker/build-push-action@')
					);
					eq(
						'12.15',
						buildPush?.with?.load,
						true,
						`${workflow.rel} build-push load (the secret check runs before any push)`,
						workflow.rel
					);
					eq('12.16', buildPush?.with?.push, false, `${workflow.rel} build-push push`, workflow.rel);
					eq(
						'12.17',
						buildPush?.with?.context,
						spec.build.context,
						`${workflow.rel} build context`,
						workflow.rel
					);
					eq(
						'12.18',
						buildPush?.with?.file,
						`${spec.build.context}/${spec.build.dockerfile}`,
						`${workflow.rel} build file`,
						workflow.rel
					);
					eq(
						'12.19',
						buildPush?.with?.target,
						spec.build.target,
						`${workflow.rel} build target`,
						workflow.rel
					);
					const buildArgs = String(buildPush?.with?.['build-args'] ?? '');
					for (const argument of spec.build.args ?? []) {
						if (argument.value !== undefined) {
							ok(
								'12.20',
								buildArgs.includes(`${argument.name}=${argument.value}`),
								`${workflow.rel} passes \`${argument.name}\` as a literal build arg`,
								workflow.rel
							);
						} else {
							ok(
								'12.21',
								buildArgs.includes(
									`${argument.name}=\${{ github.event_name == 'pull_request' && 'ew-restricted' || secrets.EW_${argument.fromEnv} }}`
								),
								`${workflow.rel} passes \`${argument.name}\` from the EW_ secret with the §4.7b restricted pull-request form`,
								workflow.rel
							);
						}
					}
					if ((spec.build.services ?? []).length) {
						const services = build.services ?? {};
						for (const service of spec.build.services) {
							eq(
								'12.22',
								services[service.name]?.image,
								service.image,
								`${workflow.rel} build service ${service.name}`,
								workflow.rel
							);
						}
						eq(
							'12.23',
							buildPush?.with?.network,
							'host',
							`${workflow.rel} build-push network (services need it)`,
							workflow.rel
						);
					}
				}
			} else {
				ok(
					'12.24',
					!build,
					`${workflow.rel} declares no \`build\` job (strategy ${buildStrategy})`,
					workflow.rel
				);
			}
			const verifyJob = doc.jobs?.verify;
			if (buildStrategy === 'dockerfile') {
				if (
					ok(
						'12.39',
						Boolean(verifyJob),
						`${workflow.rel} carries the \`verify\` job of APW-05 plan.md §2.4:243-274`,
						workflow.rel
					)
				) {
					eq(
						'12.40',
						verifyJob['timeout-minutes'],
						spec.build.resources.timeoutMinutes + 30,
						`${workflow.rel} verify timeout-minutes (build.resources.timeoutMinutes + 30, FR-53)`,
						workflow.rel
					);
					eq(
						'12.41',
						JSON.stringify(verifyJob.permissions),
						JSON.stringify({ contents: 'read', packages: 'read' }),
						`${workflow.rel} verify permissions — never \`packages: write\` (FR-54)`,
						workflow.rel
					);
					ok(
						'12.42',
						String(verifyJob.if).includes("inputs.ew_mode == 'verify'"),
						`${workflow.rel} verify job guard — \`github.event_name == 'workflow_dispatch' && inputs.ew_mode == 'verify'\``,
						workflow.rel
					);
					ok(
						'12.43',
						!JSON.stringify(verifyJob).includes('docker push') &&
							!JSON.stringify(verifyJob).includes('cache-to'),
						`${workflow.rel} verify job never pushes an image and never writes the cache (APW-05 plan.md:304-307)`,
						workflow.rel
					);
				}
				const checksJobEarly = doc.jobs?.checks;
				void checksJobEarly;
			}
			const checksJob = doc.jobs?.checks;
			if (checks.length) {
				if (ok('12.25', Boolean(checksJob), `${workflow.rel} has a \`checks\` job (R-9)`, workflow.rel)) {
					eq(
						'12.26',
						checksJob.name,
						'Ever Works check: ${{ matrix.check.name }}',
						`${workflow.rel} checks job name (the check-run name)`,
						workflow.rel
					);
					eq(
						'12.27',
						checksJob.strategy['max-parallel'],
						5,
						`${workflow.rel} checks max-parallel`,
						workflow.rel
					);
					eq(
						'12.28',
						checksJob.strategy['fail-fast'],
						false,
						`${workflow.rel} checks fail-fast`,
						workflow.rel
					);
					eq(
						'12.29',
						JSON.stringify(checksJob.permissions),
						JSON.stringify({ contents: 'read' }),
						`${workflow.rel} checks permissions`,
						workflow.rel
					);
					const matrix = checksJob.strategy.matrix.check;
					eq('12.30', matrix.length, checks.length, `${workflow.rel} check matrix length`, workflow.rel);
					checks.forEach((check, index) => {
						const row = matrix[index] ?? {};
						eq('12.31', row.name, check.name, `${workflow.rel} matrix[${index}].name`, workflow.rel);
						eq(
							'12.32',
							row.required,
							check.required ?? true,
							`${workflow.rel} matrix[${index}].required`,
							workflow.rel
						);
						eq(
							'12.33',
							row.timeoutMinutes,
							Math.ceil(check.timeoutSeconds / 60),
							`${workflow.rel} matrix[${index}].timeoutMinutes`,
							workflow.rel
						);
						eq(
							'12.34',
							row.commandB64,
							Buffer.from(check.command, 'utf8').toString('base64'),
							`${workflow.rel} matrix[${index}].commandB64`,
							workflow.rel
						);
					});
					ok(
						'12.35',
						String(checksJob['continue-on-error']).includes('matrix.check.required'),
						`${workflow.rel} checks continue-on-error follows \`required\``,
						workflow.rel
					);
					ok(
						'12.36',
						!workflow.text.split('checks:')[1]?.includes('secrets.'),
						`${workflow.rel} checks job references no secret (FR-66)`,
						workflow.rel
					);
				}
			} else {
				ok('12.37', !checksJob, `${workflow.rel} has no checks job (spec.checks is empty)`, workflow.rel);
			}
			ok(
				'12.38',
				!workflow.text.includes(':latest'),
				`${workflow.rel} contains no \`:latest\` image tag`,
				workflow.rel
			);
		}
	}

	/* -- 13 ── cross-checks against the App spec schema ------------------------------------------ */
	suite(
		`${id} · 13 · App spec schema cross-check`,
		'every rendered field exists in app-spec.schema.json with the right shape'
	);
	for (const component of spec.components) {
		for (const volume of component.volumes ?? []) {
			const claim = clusterKind('PersistentVolumeClaim', `${component.name}-${volume.name}`);
			const where = `${id}/your-cluster/06-persistentvolumeclaim-${component.name}-${volume.name}.yaml`;
			if (
				!ok(
					'13.1',
					Boolean(claim),
					`a PVC is rendered for \`${component.name}.volumes[${volume.name}]\``,
					where
				)
			)
				continue;
			eq(
				'13.2',
				claim.doc.spec?.resources?.requests?.storage,
				volume.size,
				`${where} storage (spec.components[].volumes[].size)`,
				where
			);
			eq(
				'13.3',
				claim.doc.metadata?.annotations?.['ever-works.io/backup'],
				String(volume.backup ?? true),
				`${where} backup annotation`,
				where
			);
			eq('13.4', claim.doc.spec?.accessModes?.[0], 'ReadWriteOnce', `${where} accessModes`, where);
			const deployment = clusterKind('Deployment', component.name);
			const mounts = deployment?.doc.spec.template.spec.containers[0].volumeMounts ?? [];
			ok(
				'13.5',
				mounts.some((mount) => mount.name === volume.name && mount.mountPath === volume.path),
				`${where} is mounted at the declared path ${volume.path}`,
				where
			);
		}
		if ((component.volumes ?? []).length && (component.replicas ?? 1) > 1) {
			ok(
				'13.6',
				false,
				`spec.components[${component.name}] has volumes and replicas > 1 — schema R18 rejects this Blueprint`,
				bp.file
			);
		} else {
			ok('13.6', true, `spec.components[${component.name}] honours R18 (volumes ⇒ at most 1 replica)`, bp.file);
		}
		if (component.resources?.memory) {
			const mebibytes = /^(\d+)Mi$/.exec(component.resources.memory);
			const gibibytes = /^(\d+)Gi$/.exec(component.resources.memory);
			const value = mebibytes ? Number(mebibytes[1]) : gibibytes ? Number(gibibytes[1]) * 1024 : null;
			ok(
				'13.7',
				value !== null && value >= 64 && value <= 256 * 1024,
				`spec.components[${component.name}].resources.memory ${component.resources.memory} is inside MemQuantity 64Mi–256Gi (schema.md:28)`,
				bp.file
			);
		}
	}
	for (const entry of spec.env) {
		ok(
			'13.8',
			!entry.name.startsWith('EVER_WORKS_'),
			`spec.env \`${entry.name}\` does not use the reserved EVER_WORKS_ prefix (schema.md R23)`,
			bp.file
		);
	}
	for (const [index, cron] of (spec.cron ?? []).entries()) {
		ok(
			'13.9',
			String(cron.schedule).trim().split(/\s+/).length === 5,
			`spec.cron[${index}].schedule \`${cron.schedule}\` is a five-field cron`,
			bp.file
		);
	}
	void golden.byKind;
	void golden.fromCluster;
}

/* --------------------------------------------------------------- report */

const out = [];
const line = (text = '') => out.push(text);
const totalChecks = results.reduce((sum, suite_) => sum + suite_.checks.length, 0);
const totalFailures = results.reduce((sum, suite_) => sum + suite_.failures.length, 0);

line('='.repeat(96));
line('Ever Works App Works — GOLDEN ARTIFACT CHECKS');
line('='.repeat(96));
line(`run at        : ${new Date().toISOString()}`);
line(`node          : ${process.version}`);
line(`repo root     : ${REPO_ROOT}`);
line(`golden root   : ${path.relative(REPO_ROOT, ROOT).replace(/\\/g, '/') || '.'}`);
line(`blueprints    : ${BLUEPRINTS.join(', ')}`);
for (const id of BLUEPRINTS) line(`                ${id.padEnd(20)} works.yml sha256 ${BLUEPRINT_SHAS[id]}`);
line('checks        : components and ports · probes · multi-step job order · cron and auth scheme ·');
line('                the runtime-vs-build env split · the platform labels · default-deny · images ·');
line('                no literal secret · the managed Work · the build workflow · the App spec schema');
line();

for (const suite_ of results) {
	line('-'.repeat(96));
	line(`SUITE  ${suite_.id} — ${suite_.title}`);
	const grouped = new Map();
	for (const check of suite_.checks) {
		if (!grouped.has(check.id)) grouped.set(check.id, { passed: 0, failed: [] });
		const bucket = grouped.get(check.id);
		if (check.passed) bucket.passed += 1;
		else bucket.failed.push(check);
	}
	for (const [id_, bucket] of grouped) {
		if (bucket.failed.length === 0) {
			line(`  PASS  ${id_.padEnd(7)} ${String(bucket.passed).padStart(3)} assertion(s)`);
		} else {
			line(`  FAIL  ${id_.padEnd(7)} ${bucket.failed.length} of ${bucket.failed.length + bucket.passed}`);
			for (const failure of bucket.failed.slice(0, 12)) {
				const prefix = failure.where && !failure.message.startsWith(failure.where) ? `${failure.where}: ` : '';
				line(`        ${prefix}${failure.message}`);
			}
			if (bucket.failed.length > 12) line(`        … ${bucket.failed.length - 12} more`);
		}
	}
	line();
}

line('='.repeat(96));
line('SUMMARY');
line('='.repeat(96));
for (const suite_ of results) {
	const failed = suite_.failures.length;
	line(
		`${(failed === 0 ? 'PASS' : 'FAIL').padEnd(5)} ${suite_.id.padEnd(46)} ${String(suite_.checks.length - failed).padStart(4)} / ${String(suite_.checks.length).padEnd(4)} assertions`
	);
}
line();
line(`assertions    : ${totalChecks}`);
line(`failures      : ${totalFailures}`);
line(
	`verdict       : ${
		totalFailures === 0
			? 'every golden file matches its App Blueprint'
			: `${totalFailures} assertion(s) failed — the golden set and the App Blueprint disagree`
	}`
);
line();
line('FINDINGS (what this run proves, and what it cannot)');
line('  1. Every rendered component name, port, replica count and probe path is read back out of the');
line('     Blueprint’s `.works/works.yml` at run time, so a golden file that drifts from its Blueprint');
line('     fails here rather than in an acceptance lane.');
line('  2. The job list is asserted in DECLARED ORDER and by phase (pre-deploy before first-deploy) —');
line('     the order is part of the contract (APW-06 spec FR-26 rows 2 and 4), not an artefact of sorting.');
line('  3. The env Secret’s key set is asserted against `phase`, both directions: a build-only name must');
line('     not appear (APW-06 plan §4.7), and a build argument must never name a runtime-only entry.');
line('  4. Every secret shape that could hold a literal is asserted to be a `<…>` reference placeholder;');
line('     the only literal values allowed are the non-secret `value:` entries the Blueprint itself states.');
line('  5. This checks DESIRED STATE only. It cannot prove rollout, rollback, smoke execution or the');
line('     deploy-time runner Jobs (smoke / hairpin / isolation probe) — those are APW-06 plan §4.11–§4.12');
line('     and are deliberately absent from the golden set.');
line();

const transcript = `${out.join('\n')}\n`;
process.stdout.write(transcript);
if (totalFailures > 0) {
	process.stderr.write(`\n${totalFailures} golden assertion(s) FAILED.\n`);
	process.exitCode = 1;
} else {
	process.stderr.write(`\nAll ${totalChecks} golden assertions passed.\n`);
}
