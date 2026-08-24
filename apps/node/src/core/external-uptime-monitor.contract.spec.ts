import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(__dirname, '../../../..');
const workflowPath = join(repositoryRoot, '.github/workflows/external-uptime-monitor.yml');

async function summaryBlock(): Promise<string> {
	const workflow = await readFile(workflowPath, 'utf8');
	const start = workflow.indexOf('# A short human summary for the issue TITLE');
	const end = workflow.indexOf('\n\n          {', start);

	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);

	return workflow
		.slice(start, end)
		.replace(/\r\n/g, '\n')
		.replace(/^ {10}/gm, '');
}

function exerciseSummary(block: string, failingUrls: string) {
	const shellLiteral = failingUrls.replace(/'/g, `'"'"'`);
	const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
	return spawnSync(
		bash,
		[
			'-euo',
			'pipefail',
			'-c',
			`FAILING_URLS='${shellLiteral}'\n${block}\nprintf '<%s>|<%s>|<%s>' "\${FAIL_COUNT}" "\${FIRST_FAIL}" "\${FAIL_SUMMARY}"\n`
		],
		{
			encoding: 'utf8',
			env: process.env
		}
	);
}

describe('external uptime monitor summary contract', () => {
	it('survives an empty failure list under the workflow Bash flags', async () => {
		const result = exerciseSummary(await summaryBlock(), '');

		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		expect(result.stdout).toBe('<0>|<>|<>');
	});

	it('keeps the first failing host in the alert summary', async () => {
		const result = exerciseSummary(
			await summaryBlock(),
			'https://demo.ever.works/\nhttps://mcp.ever.works/health\n'
		);

		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		expect(result.stdout).toBe('<2>|<demo.ever.works>|<demo.ever.works +1 more>');
	});
});
