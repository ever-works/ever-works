#!/usr/bin/env node
/**
 * EW-58 — install the automated release workflow in Ever Works data
 * repositories that already exist.
 *
 * New and regenerated data repositories get
 * `.github/workflows/release.yml` from the data generator itself
 * (`DataRepository.ensureReleaseWorkflow()`), so they need nothing from this
 * script. Repositories created BEFORE that shipped only pick the workflow up
 * on their next generation; this one-shot helper closes that gap immediately.
 *
 * It is a thin driver around the `gh` CLI so it inherits the operator's
 * existing GitHub auth — no token handling, no extra dependency. `gh auth
 * status` must report a login with `repo` and `workflow` scope (GitHub
 * rejects a write to `.github/workflows/**` without the latter).
 *
 * Usage (from the repo root):
 *
 *   node scripts/seed-data-repo-release-workflow.mjs --dry-run
 *   node scripts/seed-data-repo-release-workflow.mjs
 *   node scripts/seed-data-repo-release-workflow.mjs --org ever-works
 *   node scripts/seed-data-repo-release-workflow.mjs --repo awesome-vector-databases-data
 *
 * Options:
 *   --dry-run          report what would change, write nothing.
 *   --org <login>      GitHub owner to scan (default: ever-works).
 *   --repo <name>      operate on one repository (repeatable). Skips
 *                      discovery, so it also works for a repo whose name
 *                      does not end in `-data`.
 *   --suffix <text>    discovery suffix (default: `-data`).
 *   --limit <n>        max repositories to list during discovery
 *                      (default: 500).
 *   --include-archived also touch archived repositories (default: skip —
 *                      GitHub rejects writes to them anyway).
 *
 * Idempotent, and additive by the same rules the generator uses:
 *
 *   - no `.github/workflows/release.yml`            -> create it;
 *   - a platform-managed copy at an older revision  -> update it;
 *   - a platform-managed copy at the current one    -> skip;
 *   - anything else at that path                    -> skip, never
 *     overwrite a workflow the repository owner authored.
 *
 * Exit codes: 0 when every repository ended up created/updated/skipped
 * cleanly, 1 when at least one failed (the summary lists them).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const generatorDir = join(repoRoot, 'packages', 'agent', 'src', 'generators', 'data-generator');
const yamlPath = join(generatorDir, 'assets', 'data-repo-release.yml');

/** Must match DATA_REPO_RELEASE_WORKFLOW_PATH in release-workflow.ts. */
const WORKFLOW_PATH = '.github/workflows/release.yml';
const MARKER = 'data-repo-release';
const MARKER_PATTERN = /^#[ \t]*x-ever-works-workflow:[ \t]*([A-Za-z0-9._-]+)[ \t]*$/m;
const VERSION_PATTERN = /^#[ \t]*x-ever-works-workflow-version:[ \t]*(\d{1,9})[ \t]*$/m;

function parseArgs(argv) {
	const options = {
		dryRun: false,
		org: 'ever-works',
		repos: [],
		suffix: '-data',
		limit: 500,
		includeArchived: false
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) {
				throw new Error(`${arg} needs a value.`);
			}
			return value;
		};

		switch (arg) {
			case '--dry-run':
				options.dryRun = true;
				break;
			case '--org':
				options.org = next();
				break;
			case '--repo':
				options.repos.push(next());
				break;
			case '--suffix':
				options.suffix = next();
				break;
			case '--limit':
				options.limit = Number.parseInt(next(), 10);
				if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
					throw new Error('--limit must be a positive integer.');
				}
				break;
			case '--include-archived':
				options.includeArchived = true;
				break;
			case '--help':
			case '-h':
				console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('*/')[0]);
				process.exit(0);
				break;
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}

	return options;
}

/** Run `gh` and return stdout. `input` is piped to stdin when provided. */
function gh(args, input) {
	return execFileSync('gh', args, {
		encoding: 'utf-8',
		input,
		maxBuffer: 32 * 1024 * 1024,
		stdio: ['pipe', 'pipe', 'pipe']
	});
}

/** Run `gh`, returning `null` on a 404 instead of throwing. */
function ghOrNotFound(args) {
	try {
		return gh(args);
	} catch (error) {
		const stderr = String(error?.stderr ?? '');
		if (stderr.includes('HTTP 404') || stderr.includes('Not Found')) {
			return null;
		}
		throw error;
	}
}

function currentWorkflowVersion(source) {
	const match = VERSION_PATTERN.exec(source);
	if (!match) {
		throw new Error(
			`${yamlPath} is missing its "# x-ever-works-workflow-version:" marker comment.`
		);
	}
	return Number.parseInt(match[1], 10);
}

/** Revision of a managed copy, or null when the content is not ours. */
function installedVersion(content) {
	if (MARKER_PATTERN.exec(content)?.[1] !== MARKER) {
		return null;
	}
	const match = VERSION_PATTERN.exec(content);
	if (!match) {
		return null;
	}
	const version = Number.parseInt(match[1], 10);
	return Number.isSafeInteger(version) ? version : null;
}

function discoverRepositories(options) {
	const args = ['repo', 'list', options.org, '--limit', String(options.limit)];
	if (!options.includeArchived) {
		args.push('--no-archived');
	}
	args.push('--json', 'name,isArchived');

	const listed = JSON.parse(gh(args));

	return listed
		.filter((repo) => repo.name.endsWith(options.suffix))
		.filter((repo) => options.includeArchived || !repo.isArchived)
		.map((repo) => repo.name)
		.sort();
}

/**
 * Decide what to do with one repository and, unless `--dry-run`, do it.
 * Returns one of `created` / `updated` / `skipped-managed` / `skipped-owned`
 * / `skipped-empty`.
 */
function seedRepository(options, repo, workflow, workflowVersion) {
	const slug = `${options.org}/${repo}`;

	// An empty repository has no default branch, so there is nothing to
	// commit onto and the contents API would 409.
	const meta = ghOrNotFound(['api', `repos/${slug}`, '--jq', '.default_branch']);
	const defaultBranch = meta?.trim();
	if (!defaultBranch) {
		return 'skipped-empty';
	}

	const existing = ghOrNotFound([
		'api',
		`repos/${slug}/contents/${WORKFLOW_PATH}?ref=${encodeURIComponent(defaultBranch)}`
	]);

	let sha;
	let action = 'created';

	if (existing) {
		const parsed = JSON.parse(existing);
		const content = Buffer.from(parsed.content ?? '', parsed.encoding ?? 'base64').toString(
			'utf-8'
		);
		const version = installedVersion(content);

		if (version === null) {
			return 'skipped-owned';
		}
		if (version >= workflowVersion) {
			return 'skipped-managed';
		}

		sha = parsed.sha;
		action = 'updated';
	}

	if (options.dryRun) {
		return action;
	}

	const body = {
		message:
			action === 'created'
				? 'ci: add automated release workflow'
				: 'ci: update automated release workflow',
		content: Buffer.from(workflow, 'utf-8').toString('base64'),
		branch: defaultBranch
	};
	if (sha) {
		body.sha = sha;
	}

	// `--input -` keeps the ~8 KB base64 payload off the command line, which
	// would otherwise risk the Windows argument-length limit.
	gh(
		['api', '--method', 'PUT', `repos/${slug}/contents/${WORKFLOW_PATH}`, '--input', '-'],
		JSON.stringify(body)
	);

	return action;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const workflow = readFileSync(yamlPath, 'utf-8').replace(/\r\n/g, '\n');
	const workflowVersion = currentWorkflowVersion(workflow);

	try {
		gh(['auth', 'status']);
	} catch {
		console.error('`gh auth status` failed. Run `gh auth login` first.');
		process.exit(1);
	}

	const repos = options.repos.length > 0 ? options.repos : discoverRepositories(options);

	if (repos.length === 0) {
		console.log(`No repositories in ${options.org} match "*${options.suffix}".`);
		return;
	}

	console.log(
		`${options.dryRun ? '[dry run] ' : ''}Seeding ${WORKFLOW_PATH} (revision ${workflowVersion}) ` +
			`into ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'} under ${options.org}.\n`
	);

	const outcomes = new Map();
	const failures = [];

	for (const repo of repos) {
		try {
			const outcome = seedRepository(options, repo, workflow, workflowVersion);
			outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
			console.log(`  ${outcome.padEnd(16)} ${options.org}/${repo}`);
		} catch (error) {
			failures.push(repo);
			const detail = String(error?.stderr ?? error?.message ?? error).trim();
			console.error(`  ${'failed'.padEnd(16)} ${options.org}/${repo}: ${detail}`);
		}
	}

	console.log('\nSummary:');
	for (const [outcome, count] of [...outcomes].sort()) {
		console.log(`  ${outcome}: ${count}`);
	}
	if (failures.length > 0) {
		console.log(`  failed: ${failures.length} (${failures.join(', ')})`);
		console.log(
			'\nA 403 on a write usually means the `gh` login is missing the `workflow` scope. ' +
				'Fix it with: gh auth refresh -h github.com -s workflow'
		);
		process.exit(1);
	}
}

main();
