#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function runCommand(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ['ignore', 'pipe', 'pipe'],
			...options
		});

		let stdout = '';
		let stderr = '';

		child.stdout?.on('data', (chunk) => {
			stdout += chunk.toString('utf-8');
		});

		child.stderr?.on('data', (chunk) => {
			stderr += chunk.toString('utf-8');
		});

		child.on('error', reject);
		child.on('exit', (code) => {
			resolve({ code, stdout, stderr });
		});
	});
}

async function main() {
	const authPath = process.env.CODEX_HOME
		? path.join(process.env.CODEX_HOME, 'auth.json')
		: path.join(process.env.HOME ?? '', '.codex', 'auth.json');

	const which = await runCommand('bash', ['-lc', 'command -v codex']);
	if (which.code !== 0) {
		throw new Error('Codex CLI is not installed or not on PATH.');
	}

	if (!process.env.OPENAI_API_KEY) {
		try {
			await readFile(authPath, 'utf-8');
		} catch {
			throw new Error(
				`No OPENAI_API_KEY and no local Codex auth found at ${authPath}. Run \`codex login\` or export OPENAI_API_KEY first.`
			);
		}
	}

	const workspace = await mkdtemp(path.join(tmpdir(), 'codex-smoke-'));
	try {
		await mkdir(path.join(workspace, '_meta'), { recursive: true });
		await writeFile(
			path.join(workspace, '_meta', 'request.json'),
			JSON.stringify({ name: 'Smoke Test', prompt: 'Create one test item file' }, null, 2),
			'utf-8'
		);

		const prompt = [
			'Work only in the current workspace.',
			'Create exactly one JSON file named smoke-test-item.json in the workspace root.',
			'The JSON must include: name, description, source_url, category, tags.',
			'Use https://example.com as source_url.',
			'Do not modify files under _meta/.'
		].join(' ');

		const result = await runCommand(
			'codex',
			['exec', '--full-auto', '--skip-git-repo-check', prompt],
			{
				cwd: workspace,
				env: process.env
			}
		);

		if (result.code !== 0) {
			throw new Error(`Codex smoke run failed with exit code ${result.code}\n${result.stderr || result.stdout}`);
		}

		const expectedFile = path.join(workspace, 'smoke-test-item.json');
		let generated;
		try {
			generated = await readFile(expectedFile, 'utf-8');
		} catch (error) {
			const listing = await runCommand('bash', ['-lc', `find "${workspace}" -maxdepth 2 -type f | sort`]);
			throw new Error(
				[
					`Expected generated file was not created: ${expectedFile}`,
					'',
					'Codex stdout:',
					result.stdout || '(empty)',
					'',
					'Codex stderr:',
					result.stderr || '(empty)',
					'',
					'Workspace files:',
					listing.stdout || '(none)',
					'',
					`Workspace preserved at: ${workspace}`
				].join('\n')
			);
		}
		const parsed = JSON.parse(generated);

		for (const required of ['name', 'description', 'source_url', 'category']) {
			if (!parsed[required]) {
				throw new Error(`Generated item is missing required field: ${required}`);
			}
		}

		console.log('Codex smoke test passed.');
		console.log(`Workspace: ${workspace}`);
		console.log(parsed);
	} finally {
		if (!process.env.KEEP_CODEX_SMOKE_WORKSPACE) {
			await rm(workspace, { recursive: true, force: true });
		}
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
