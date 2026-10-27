import { describe, expect, it } from 'vitest';
import { GitHubActionsRunnersPlugin, ORG_RUNNERS_PERMISSION } from '../github-actions-runners.plugin.js';
import { rateLimitedUntilOf, runnersPath, splitRepository } from '../github-runners-api.js';

/** Actions runners (FL-18, plan §14) — the plugin against a fake GitHub. */
interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
}

function fakeGitHub(routes: Record<string, { status: number; body?: unknown; headers?: Record<string, string> }>) {
	const calls: Call[] = [];
	const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
		const method = String(init.method ?? 'GET');
		calls.push({ url, method, headers: { ...(init.headers as Record<string, string>) } });
		const path = url.replace('https://api.github.test', '');
		const route = routes[`${method} ${path}`] ?? routes[`${method} ${path.split('?')[0]}`];
		if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
		return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
			status: route.status,
			headers: route.headers
		});
	};
	return { calls, plugin: new GitHubActionsRunnersPlugin(fetchImpl, 'https://api.github.test') };
}

const TOKEN = 'ghs_installation_token_for_one_call';
const repo = { scope: 'repo' as const, target: 'acme/api' };
const org = { scope: 'org' as const, target: 'acme' };

describe('paths', () => {
	it('names the repository and organisation runner collections and refuses anything else', () => {
		expect(runnersPath(repo)).toBe('/repos/acme/api/actions/runners');
		expect(runnersPath(org)).toBe('/orgs/acme/actions/runners');
		expect(() => splitRepository('acme/../x')).toThrow();
		expect(() => splitRepository('acme')).toThrow();
	});
});

describe('GitHubActionsRunnersPlugin', () => {
	it('maps the download list and keeps only builds with a checksum', async () => {
		const { plugin, calls } = fakeGitHub({
			'GET /repos/acme/api/actions/runners/downloads': {
				status: 200,
				body: [
					{
						os: 'linux',
						architecture: 'x64',
						download_url:
							'https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-x64-2.321.0.tar.gz',
						filename: 'actions-runner-linux-x64-2.321.0.tar.gz',
						sha256_checksum: 'A'.repeat(64)
					},
					{ os: 'osx', architecture: 'arm64', download_url: 'https://x', filename: 'x.tar.gz' }
				]
			}
		});
		const downloads = await plugin.listDownloads(repo, TOKEN);
		expect(downloads).toEqual([
			{
				os: 'linux',
				architecture: 'x64',
				downloadUrl:
					'https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-x64-2.321.0.tar.gz',
				filename: 'actions-runner-linux-x64-2.321.0.tar.gz',
				sha256: 'a'.repeat(64)
			}
		]);
		expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(calls[0].headers['X-GitHub-Api-Version']).toBe('2022-11-28');
	});

	it('mints registration and remove tokens on the target scope', async () => {
		const { plugin } = fakeGitHub({
			'POST /orgs/acme/actions/runners/registration-token': {
				status: 201,
				body: { token: 'REG', expires_at: '2026-10-21T11:00:00Z' }
			},
			'POST /repos/acme/api/actions/runners/remove-token': {
				status: 201,
				body: { token: 'REM', expires_at: null }
			}
		});
		expect(await plugin.mintRegistrationToken(org, TOKEN)).toEqual({
			token: 'REG',
			expiresAt: '2026-10-21T11:00:00Z'
		});
		expect(await plugin.mintRemoveToken(repo, TOKEN)).toEqual({ token: 'REM', expiresAt: null });
	});

	it('lists runners with their status, busy flag and labels, conditionally', async () => {
		const { plugin, calls } = fakeGitHub({
			'GET /repos/acme/api/actions/runners': {
				status: 200,
				headers: { etag: 'W/"abc"', 'x-ratelimit-remaining': '4999' },
				body: {
					total_count: 1,
					runners: [
						{
							id: 7,
							name: 'build-01-1',
							os: 'Linux',
							status: 'online',
							busy: true,
							labels: [{ name: 'self-hosted' }, { name: 'gpu' }]
						}
					]
				}
			}
		});
		const page = await plugin.listRunners(repo, TOKEN, { etag: 'W/"old"' });
		expect(page.runners).toEqual([
			{ id: 7, name: 'build-01-1', os: 'Linux', status: 'online', busy: true, labels: ['self-hosted', 'gpu'] }
		]);
		expect(page.etag).toBe('W/"abc"');
		expect(page.rateLimitRemaining).toBe(4999);
		expect(calls[0].headers['If-None-Match']).toBe('W/"old"');
	});

	it('answers notModified on a 304', async () => {
		const { plugin } = fakeGitHub({ 'GET /repos/acme/api/actions/runners': { status: 304 } });
		const page = await plugin.listRunners(repo, TOKEN, { etag: 'W/"abc"' });
		expect(page.notModified).toBe(true);
		expect(page.etag).toBe('W/"abc"');
	});

	it('turns a rate limit into rate_limited with the reset instant, and a 403 into a missing permission', async () => {
		const { plugin } = fakeGitHub({
			'GET /repos/acme/api/actions/runners': {
				status: 403,
				headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1798000000' },
				body: { message: 'API rate limit exceeded' }
			},
			'GET /orgs/acme/actions/runners': {
				status: 403,
				body: { message: 'Resource not accessible by integration' }
			}
		});
		await expect(plugin.listRunners(repo, TOKEN)).rejects.toMatchObject({
			name: 'ActionsRunnersApiError',
			code: 'rate_limited',
			rateLimitedUntil: new Date(1798000000 * 1000).toISOString()
		});
		expect(await plugin.checkPermission(org, TOKEN)).toEqual({ ok: false, missing: ORG_RUNNERS_PERMISSION });
	});

	it('treats an already-deleted runner as deleted and cancels a whole workflow run', async () => {
		const { plugin, calls } = fakeGitHub({
			'POST /repos/acme/api/actions/runs/4822/cancel': { status: 202, body: {} }
		});
		await expect(plugin.deleteRunner(repo, 7, TOKEN)).resolves.toBeUndefined();
		await expect(plugin.cancelRun('acme/api', 4822, TOKEN)).resolves.toBeUndefined();
		expect(calls.map((call) => `${call.method} ${call.url}`)).toContain(
			'POST https://api.github.test/repos/acme/api/actions/runs/4822/cancel'
		);
	});

	it('never puts the token anywhere but the Authorization header', async () => {
		const { plugin, calls } = fakeGitHub({
			'GET /repos/acme/api/actions/runners': { status: 500, body: { message: 'boom' } }
		});
		const error = await plugin.listRunners(repo, TOKEN).catch((caught: Error) => caught);
		expect(String((error as Error).message)).not.toContain(TOKEN);
		expect(calls.every((call) => !call.url.includes(TOKEN))).toBe(true);
	});
});

describe('rateLimitedUntilOf', () => {
	it('reads retry-after first, then the reset header', () => {
		const now = Date.parse('2026-10-21T10:00:00Z');
		expect(rateLimitedUntilOf(new Response(null, { status: 429, headers: { 'retry-after': '30' } }), now)).toBe(
			'2026-10-21T10:00:30.000Z'
		);
		expect(rateLimitedUntilOf(new Response(null, { status: 200 }), now)).toBeNull();
		expect(rateLimitedUntilOf(new Response(null, { status: 403 }), now)).toBeNull();
	});
});
