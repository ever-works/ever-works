import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PluginContext } from '@ever-works/plugin';
import { APW_E2E_FAKES_SWITCH_ENV, APW_E2E_GITHUB_FAKE_URL_ENV, resolveGitHubE2eFakeOrigin } from '../e2e-fakes.js';

/**
 * APW-13 T5 — the non-production `EVER_WORKS_E2E_FAKES` switch (CONTRACTS §7,
 * plan §8.3 "Pointing the platform at it" and "Every URL builder the switch must
 * cover").
 *
 * The switch exists so the App Works acceptance lanes can point the platform's
 * GitHub paths at the fake server of T2 instead of the real service. Five things
 * this suite keeps true, each of them a way a lane could silently reach GitHub:
 *
 * 1. **Armed only on purpose.** `EVER_WORKS_E2E_FAKES` must be exactly `'1'`, and
 *    `NODE_ENV=production` refuses the switch outright — a production deployment
 *    cannot be pointed at a fake even with the variables in its environment.
 * 2. **The admin setting and its SSRF guard are untouched.** A loopback
 *    `apiBaseUrl` setting is still refused when the switch is off; with the
 *    switch on it is the switch's own origin that is used, never the (possibly
 *    unchecked) configured value. The guard runs first, on the configured value,
 *    exactly as it did before APW-13 — the switch only replaces what the guard
 *    produced.
 * 3. **Every URL builder, not just the API base.** `getCloneUrl` is the factory
 *    `GitOperations` hands to isomorphic-git, `getWebUrl` feeds Activity and PR
 *    payloads, and the service builds both the `full_name` clone-URL fallback and
 *    the `raw.githubusercontent.com` content URL. Each is asserted with the
 *    switch on AND off.
 * 4. **Read at call time.** The environment is read inside the resolver, so a
 *    lane (and this suite) can flip the switch between calls — including after
 *    `onLoad`, which is what the clone-URL test below does on purpose.
 * 5. **Nothing here reaches the network.** Octokit is replaced by a double that
 *    records the `baseUrl` it was constructed with (the sibling
 *    `github-api.service.*.spec.ts` suites mock it the same way), and
 *    `GitOperations` by a double that records the clone-URL factory the plugin
 *    injects. No fetch is issued and no clone is attempted.
 */

const FAKE_ORIGIN = 'http://127.0.0.1:3900';
/** A loopback value in the ADMIN setting — the guard must never let it through. */
const LOOPBACK_ADMIN_SETTING = 'http://127.0.0.1:3999';
/** A guard-approved (public) value in the admin setting. */
const ENTERPRISE_ADMIN_SETTING = 'https://github.enterprise.example/api/v3';

// --- Doubles ---------------------------------------------------------------

/** Every `new Octokit({...})` the suite caused, in order. */
const octokitOptions: Array<{ baseUrl?: string; auth?: string }> = [];
const getAuthenticatedMock = vi.fn();
const listForAuthenticatedUserMock = vi.fn();

vi.mock('octokit', () => {
	class FakeRequestError extends Error {
		status?: number;
		response?: { data?: unknown; headers?: Record<string, string | number> };
	}

	class FakeOctokit {
		rest = {
			users: { getAuthenticated: (...args: unknown[]) => getAuthenticatedMock(...args) },
			repos: { listForAuthenticatedUser: (...args: unknown[]) => listForAuthenticatedUserMock(...args) }
		};

		constructor(options: { baseUrl?: string; auth?: string }) {
			octokitOptions.push(options);
		}
	}

	return { Octokit: FakeOctokit, RequestError: FakeRequestError };
});

/** The clone-URL factory each constructed `GitOperations` received. */
const injectedCloneUrlFactories: Array<(owner: string, repo: string) => string> = [];

vi.mock('@ever-works/plugin/git', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();

	class FakeGitOperations {
		constructor(_getAuth: unknown, getCloneUrl: (owner: string, repo: string) => string) {
			injectedCloneUrlFactories.push(getCloneUrl);
		}

		async cloneOrPull(): Promise<string> {
			return '/tmp/apw-13-e2e-fakes-switch/checkout';
		}
	}

	return { ...actual, GitOperations: FakeGitOperations };
});

vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const { GitHubPlugin } = await import('../github.plugin.js');
const { GitHubApiService } = await import('../github-api.service.js');

// The classes are destructured at runtime, so the instance types come from the
// values: `InstanceType<typeof X>` keeps this file type-clean even though the
// package's `tsconfig.json` excludes specs from its `type-check` script.
type GitHubPluginInstance = InstanceType<typeof GitHubPlugin>;
type GitHubApiServiceInstance = InstanceType<typeof GitHubApiService>;

// --- Environment handling --------------------------------------------------

const MUTATED_ENV_VARS = ['NODE_ENV', APW_E2E_FAKES_SWITCH_ENV, APW_E2E_GITHUB_FAKE_URL_ENV] as const;
const savedEnv = new Map<string, string | undefined>();
for (const key of MUTATED_ENV_VARS) {
	savedEnv.set(key, process.env[key]);
}

function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

/** Arm the switch the way a lane process does. */
function armSwitch(nodeEnv = 'test', fakeUrl: string | undefined = FAKE_ORIGIN): void {
	setEnv('NODE_ENV', nodeEnv);
	setEnv(APW_E2E_FAKES_SWITCH_ENV, '1');
	setEnv(APW_E2E_GITHUB_FAKE_URL_ENV, fakeUrl);
}

/** The switch is off: no arming variable, no origin. */
function disarmSwitch(nodeEnv: string | undefined = 'test'): void {
	setEnv('NODE_ENV', nodeEnv);
	setEnv(APW_E2E_FAKES_SWITCH_ENV, undefined);
	setEnv(APW_E2E_GITHUB_FAKE_URL_ENV, undefined);
}

// --- Fixtures --------------------------------------------------------------

const buildContext = (settings: Record<string, unknown> = {}): PluginContext =>
	({
		pluginId: 'github',
		logger: {
			log: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		},
		getSettings: vi.fn().mockResolvedValue(settings)
	}) as unknown as PluginContext;

/** A repository payload shaped the way the fake serves one: no `clone_url` at all. */
const repoWithoutCloneUrl = {
	owner: { login: 'acme' },
	name: 'demo',
	full_name: 'acme/demo',
	description: null,
	default_branch: 'main',
	private: false,
	html_url: 'https://github.com/acme/demo',
	fork: false,
	permissions: { admin: true, push: true, pull: true }
};

/** The same shape WITH the provider's own clone URL — which is never replaced. */
const repoWithReportedCloneUrl = {
	...repoWithoutCloneUrl,
	name: 'reported',
	full_name: 'acme/reported',
	clone_url: 'https://github.com/acme/reported.git'
};

/** The URL Octokit was last constructed with — i.e. the base URL of every call. */
function lastBaseUrl(): string | undefined {
	expect(octokitOptions.length).toBeGreaterThan(0);
	return octokitOptions[octokitOptions.length - 1]?.baseUrl;
}

// --- Suite -----------------------------------------------------------------

describe('APW-13 T5 — the EVER_WORKS_E2E_FAKES switch', () => {
	let plugin: GitHubPluginInstance;
	let service: GitHubApiServiceInstance;

	beforeEach(() => {
		octokitOptions.length = 0;
		injectedCloneUrlFactories.length = 0;
		getAuthenticatedMock
			.mockReset()
			.mockResolvedValue({ data: { id: 1, login: 'acme', name: null, email: null, avatar_url: '' } });
		// Fresh payload objects per test: the service is expected to build the
		// fallback without rewriting the response it was handed, so a suite that
		// shared one object would hide that.
		listForAuthenticatedUserMock
			.mockReset()
			.mockResolvedValue({ data: [{ ...repoWithReportedCloneUrl }, { ...repoWithoutCloneUrl }] });
		// Deterministic starting point: off, in a plain test environment.
		disarmSwitch();
		plugin = new GitHubPlugin();
		service = new GitHubApiService();
	});

	afterEach(() => {
		// Restore every variable this suite mutates, so nothing leaks out of it.
		for (const key of MUTATED_ENV_VARS) {
			setEnv(key, savedEnv.get(key));
		}
	});

	describe('resolveGitHubE2eFakeOrigin', () => {
		it('returns the fake origin and strips a trailing slash', () => {
			armSwitch('test', `${FAKE_ORIGIN}/`);
			expect(resolveGitHubE2eFakeOrigin()).toBe(FAKE_ORIGIN);
		});

		it('is undefined when the origin is unset, empty, or nothing but slashes', () => {
			for (const value of [undefined, '', '   ', '/', '//']) {
				armSwitch('test');
				setEnv(APW_E2E_GITHUB_FAKE_URL_ENV, value);
				expect(resolveGitHubE2eFakeOrigin()).toBeUndefined();
			}
		});

		it('is undefined unless EVER_WORKS_E2E_FAKES is exactly "1"', () => {
			for (const value of ['true', 'yes', '0', '01', 'TRUE', '']) {
				armSwitch('test');
				setEnv(APW_E2E_FAKES_SWITCH_ENV, value);
				expect(resolveGitHubE2eFakeOrigin()).toBeUndefined();
			}
		});

		it('is undefined in production even when armed', () => {
			armSwitch('production');
			expect(resolveGitHubE2eFakeOrigin()).toBeUndefined();
		});

		it('reads the environment at call time, not at module load', () => {
			disarmSwitch();
			expect(resolveGitHubE2eFakeOrigin()).toBeUndefined();
			armSwitch();
			expect(resolveGitHubE2eFakeOrigin()).toBe(FAKE_ORIGIN);
			disarmSwitch();
			expect(resolveGitHubE2eFakeOrigin()).toBeUndefined();
		});
	});

	describe('the API base URL of every call', () => {
		it.each([['test'], ['development']])('uses the fake when NODE_ENV=%s', async (nodeEnv) => {
			armSwitch(nodeEnv);
			await plugin.onLoad(buildContext({}));

			await plugin.getUser('tok');

			expect(octokitOptions).toHaveLength(1);
			expect(lastBaseUrl()).toBe(FAKE_ORIGIN);
		});

		it('uses the fake origin with the trailing slash stripped', async () => {
			armSwitch('test', `${FAKE_ORIGIN}/`);
			await plugin.onLoad(buildContext({}));

			await plugin.getUser('tok');

			expect(lastBaseUrl()).toBe(FAKE_ORIGIN);
		});

		it('ignores the switch with NODE_ENV=production', async () => {
			armSwitch('production');
			await plugin.onLoad(buildContext({}));

			await plugin.getUser('tok');

			expect(lastBaseUrl()).toBe('https://api.github.com');
			expect(plugin.getCloneUrl('acme', 'demo')).toBe('https://github.com/acme/demo.git');
			expect(plugin.getWebUrl('acme', 'demo')).toBe('https://github.com/acme/demo');
		});

		it.each([['true'], ['0'], ['']])(
			'ignores the switch when EVER_WORKS_E2E_FAKES is %j rather than "1"',
			async (value) => {
				armSwitch('test');
				setEnv(APW_E2E_FAKES_SWITCH_ENV, value);
				await plugin.onLoad(buildContext({}));

				await plugin.getUser('tok');

				expect(lastBaseUrl()).toBe('https://api.github.com');
				expect(plugin.getCloneUrl('acme', 'demo')).toBe('https://github.com/acme/demo.git');
			}
		);

		it('ignores the switch when EVER_WORKS_E2E_FAKES is unset but the origin is set', async () => {
			disarmSwitch();
			setEnv(APW_E2E_GITHUB_FAKE_URL_ENV, FAKE_ORIGIN);
			await plugin.onLoad(buildContext({}));

			await plugin.getUser('tok');

			expect(lastBaseUrl()).toBe('https://api.github.com');
		});

		it('still refuses a loopback apiBaseUrl SETTING when the switch is off', async () => {
			disarmSwitch();
			await plugin.onLoad(buildContext({ apiBaseUrl: LOOPBACK_ADMIN_SETTING }));

			await plugin.getUser('tok');

			expect(lastBaseUrl()).toBe('https://api.github.com');
		});

		it('still refuses that setting in production, armed', async () => {
			armSwitch('production');
			await plugin.onLoad(buildContext({ apiBaseUrl: LOOPBACK_ADMIN_SETTING }));

			await plugin.getUser('tok');

			expect(lastBaseUrl()).toBe('https://api.github.com');
		});

		it('never uses the configured value while the switch is on — the fake wins', async () => {
			armSwitch('test');
			// The setting is loopback and differs from the fake's port, so a base URL
			// equal to the fake's origin can only come from the switch.
			await plugin.onLoad(buildContext({ apiBaseUrl: LOOPBACK_ADMIN_SETTING }));

			await plugin.getUser('tok');

			expect(lastBaseUrl()).toBe(FAKE_ORIGIN);
			expect(lastBaseUrl()).not.toBe(LOOPBACK_ADMIN_SETTING);
		});

		it('overrides a guard-approved configured value too', async () => {
			armSwitch('test');
			await plugin.onLoad(buildContext({ apiBaseUrl: ENTERPRISE_ADMIN_SETTING }));

			await plugin.getUser('tok');

			expect(lastBaseUrl()).toBe(FAKE_ORIGIN);
		});

		it('leaves a guard-approved configured value alone when the switch is off', async () => {
			disarmSwitch();
			await plugin.onLoad(buildContext({ apiBaseUrl: ENTERPRISE_ADMIN_SETTING }));

			await plugin.getUser('tok');

			expect(lastBaseUrl()).toBe(ENTERPRISE_ADMIN_SETTING);
		});
	});

	describe('getCloneUrl and getWebUrl', () => {
		it('return the fake origin under the switch', () => {
			armSwitch('development');
			expect(plugin.getCloneUrl('acme', 'demo')).toBe(`${FAKE_ORIGIN}/acme/demo.git`);
			expect(plugin.getWebUrl('acme', 'demo')).toBe(`${FAKE_ORIGIN}/acme/demo`);
		});

		it('return github.com without the switch', () => {
			disarmSwitch();
			expect(plugin.getCloneUrl('acme', 'demo')).toBe('https://github.com/acme/demo.git');
			expect(plugin.getWebUrl('acme', 'demo')).toBe('https://github.com/acme/demo');
		});

		it('are read at call time, so a lane can arm the switch after onLoad', async () => {
			disarmSwitch();
			await plugin.onLoad(buildContext({}));
			expect(plugin.getCloneUrl('acme', 'demo')).toBe('https://github.com/acme/demo.git');

			armSwitch();

			expect(plugin.getCloneUrl('acme', 'demo')).toBe(`${FAKE_ORIGIN}/acme/demo.git`);
			expect(plugin.getWebUrl('acme', 'demo')).toBe(`${FAKE_ORIGIN}/acme/demo`);
		});
	});

	describe('the clone URL GitOperations receives', () => {
		// `GitOperations` is doubled for this suite, so no clone is attempted and no
		// network I/O can happen: what is asserted is the factory the plugin INJECTS
		// (`github.plugin.ts` `onLoad`/`ensureGitOps` pass `(owner, repo) =>
		// this.getCloneUrl(owner, repo)`, and `GitOperations.cloneOrPull` uses it as
		// `const url = this.getCloneUrl(owner, repo)` before any git call). The
		// double is the only way to observe that URL without a real fetch.
		it('is the fake clone URL under the switch, and the GitHub one without it', async () => {
			disarmSwitch();
			await plugin.onLoad(buildContext({}));
			expect(injectedCloneUrlFactories).toHaveLength(1);
			expect(injectedCloneUrlFactories[0]('acme', 'demo')).toBe('https://github.com/acme/demo.git');

			armSwitch();

			// Same injected factory, read at call time: a lane that arms the switch
			// after the plugin loaded still clones the fake.
			expect(injectedCloneUrlFactories[0]('acme', 'demo')).toBe(`${FAKE_ORIGIN}/acme/demo.git`);

			// And the clone path really goes through that one instance.
			await plugin.cloneOrPull({ owner: 'acme', repo: 'demo', token: 'tok' });
			expect(injectedCloneUrlFactories).toHaveLength(1);
		});
	});

	describe('github-api.service.ts URL builders', () => {
		it('honours the switch in the full_name clone-URL fallback', async () => {
			armSwitch();

			const repos = await service.listRepositories('tok');

			// The payload that reported its own clone_url keeps GitHub's value...
			expect(repos[0]?.cloneUrl).toBe('https://github.com/acme/reported.git');
			// ...and the one that did not gets the fake's.
			expect(repos[1]?.cloneUrl).toBe(`${FAKE_ORIGIN}/acme/demo.git`);
		});

		it('leaves the full_name fallback on github.com without the switch', async () => {
			disarmSwitch();

			const repos = await service.listRepositories('tok');

			expect(repos[1]?.cloneUrl).toBe('https://github.com/acme/demo.git');
		});

		it('honours the switch in getRawFileUrl, after every segment validation', () => {
			armSwitch();

			expect(service.getRawFileUrl('acme', 'demo', 'main', '.works/works.yml')).toBe(
				`${FAKE_ORIGIN}/acme/demo/main/.works/works.yml`
			);
			// The refusals are untouched and still run before a URL is built.
			expect(() => service.getRawFileUrl('acme', 'demo', 'main', '../secrets.yml')).toThrow(
				/path traversal in URL segment/
			);
			expect(() => service.getRawFileUrl('acme', 'demo', 'main', '%2e%2e/secrets.yml')).toThrow(
				/illegal character in URL segment/
			);
			expect(() => service.getRawFileUrl('acme/demo', 'demo', 'main', 'README.md')).toThrow(
				/unexpected slash in URL segment/
			);
		});

		it('leaves getRawFileUrl on raw.githubusercontent.com without the switch', () => {
			disarmSwitch();

			expect(service.getRawFileUrl('acme', 'demo', 'main', 'README.md')).toBe(
				'https://raw.githubusercontent.com/acme/demo/main/README.md'
			);
		});
	});
});
