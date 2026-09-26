import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitProviderRequestError } from '@ever-works/plugin/git';

/**
 * APW-02 T20 — `GitHubApiService.setActionsPermissions` (plan §4.3, FR-27,
 * FR-30, ACC-02-08, ACC-02-20).
 *
 * The hygiene pass is the one place that turns a member's repository quiet, so
 * the assertions here are about the limits of what it may touch:
 *
 * - **The listing cap binds.** `maxWorkflows` (100 by default) is a real page
 *   bound, and `truncated` reports what the provider actually had — 150
 *   workflows under a cap of 100 is a PARTIAL pass, and §3.3 forbids reporting
 *   one as complete. A cap that cannot be turned off by passing `0` is asserted
 *   too: a disabled bound is a bound that does not exist.
 * - **`skipWorkflowIds` are never touched**, in either direction (FR-27: those
 *   ids were already judged, so re-enabling one is as wrong as disabling it).
 * - **`disableWorkflowsExcept` keeps exactly its allowlist** and touches nothing
 *   that is already disabled.
 * - **`enableWorkflows` enables only the paths it names**, and it does enable
 *   them whatever their state — the reading of §4.3 documented on the method
 *   (a hygiene pass disables everything but the build workflow first, so
 *   APW-05's deploy workflow is `disabled_manually` by the time it is asked
 *   for, and a literal "active workflows only" reading would make the parameter
 *   useless in exactly the case it exists for).
 * - **The repository switch is sent only when `enabled` is present**, and when
 *   it is absent the current value is read rather than assumed.
 * - **A 403 names the permission and stops the pass.** Not a generic failure:
 *   §4.3's row is `permission_missing`, with `administration` for an App
 *   installation token and `actions` otherwise — the two answers the caller
 *   turns into different member-facing states (§6.7's `needs_admin` vs
 *   `permission_missing`). And a rate limit must NOT be laundered into a
 *   permission problem by that override.
 *
 * Octokit is mocked, exactly as the sibling `github-api.service.*.spec.ts`
 * suites do: nothing here can reach the network.
 */

vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const setRepoPermissionsMock = vi.fn();
const getRepoPermissionsMock = vi.fn();
const listWorkflowsMock = vi.fn();
const enableWorkflowMock = vi.fn();
const disableWorkflowMock = vi.fn();

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = {
			actions: {
				setGithubActionsPermissionsRepository: (...args: unknown[]) => setRepoPermissionsMock(...args),
				getGithubActionsPermissionsRepository: (...args: unknown[]) => getRepoPermissionsMock(...args),
				listRepoWorkflows: (...args: unknown[]) => listWorkflowsMock(...args),
				enableWorkflow: (...args: unknown[]) => enableWorkflowMock(...args),
				disableWorkflow: (...args: unknown[]) => disableWorkflowMock(...args)
			}
		};
		constructor(public opts: unknown) {}
	}

	class FakeRequestError extends Error {
		status?: number;
		response?: { data?: unknown; headers?: Record<string, string | number> };
	}

	return { Octokit: FakeOctokit, RequestError: FakeRequestError };
});

const { RequestError } = await import('octokit');
const { GitHubApiService } = await import('../github-api.service.js');
const { GitHubPlugin } = await import('../github.plugin.js');

const OWNER = 'ever-works';
const REPO = 'app-data';
const TOKEN = 'ghp_secret';
const BUILD_PATH = '.github/workflows/app-build.yml';
const DEPLOY_PATH = '.github/workflows/app-deploy.yml';
const OTHER_PATH = '.github/workflows/release.yml';

/** A GitHub status error, shaped the way Octokit raises one. */
function statusError(status: number, message: string, headers: Record<string, string | number> = {}): Error {
	const ctor = RequestError as unknown as new (message: string) => Error;
	const error = new ctor(message);
	const shaped = error as Error & { status?: number; response?: unknown };
	shaped.status = status;
	shaped.response = { data: { message }, headers };
	return error;
}

interface Workflow {
	id: number;
	path: string;
	state: string;
}

/** `n` workflows named `wf-<i>.yml`, all active, starting at id 1000. */
function workflows(count: number, state = 'active'): Workflow[] {
	return Array.from({ length: count }, (_, index) => ({
		id: 1000 + index,
		path: `.github/workflows/wf-${index}.yml`,
		state
	}));
}

/** `listRepoWorkflows`, served page by page from a fixed listing. */
function pagedWorkflows(all: Workflow[]) {
	return vi.fn(async ({ page, per_page }: { page?: number; per_page?: number }) => {
		const size = per_page ?? 30;
		const start = ((page ?? 1) - 1) * size;
		return { data: { total_count: all.length, workflows: all.slice(start, start + size) } };
	});
}

/** The ids the mock was asked to disable, in call order. */
function disabledIds(): number[] {
	return disableWorkflowMock.mock.calls.map((call) => (call[0] as { workflow_id: number }).workflow_id);
}

/** The ids the mock was asked to enable, in call order. */
function enabledIds(): number[] {
	return enableWorkflowMock.mock.calls.map((call) => (call[0] as { workflow_id: number }).workflow_id);
}

let svc: InstanceType<typeof GitHubApiService>;

beforeEach(() => {
	svc = new GitHubApiService();
	setRepoPermissionsMock.mockReset().mockResolvedValue({ data: {} });
	getRepoPermissionsMock.mockReset().mockResolvedValue({ data: { enabled: true, allowed_actions: 'all' } });
	listWorkflowsMock.mockReset();
	enableWorkflowMock.mockReset().mockResolvedValue({ data: {} });
	disableWorkflowMock.mockReset().mockResolvedValue({ data: {} });
});

describe('GitHubApiService.setActionsPermissions — the listing cap binds (ACC-02-20)', () => {
	it('reports truncated for 150 workflows under a cap of 100, and sees only 100', async () => {
		const all = workflows(150);
		listWorkflowsMock.mockImplementation(pagedWorkflows(all));

		const result = await svc.setActionsPermissions(OWNER, REPO, { maxWorkflows: 100 }, TOKEN);

		expect(result.truncated).toBe(true);
		expect(result.seenIds).toEqual(all.slice(0, 100).map((workflow) => workflow.id));
		// Two reads: the full first page, and the one-item peek that answers
		// `truncated` rather than assuming it.
		expect(listWorkflowsMock).toHaveBeenCalledTimes(2);
		expect(listWorkflowsMock.mock.calls.map((call) => (call[0] as { page: number }).page)).toEqual([1, 2]);
	});

	it('reports NOT truncated when the repository has exactly the cap', async () => {
		const all = workflows(100);
		listWorkflowsMock.mockImplementation(pagedWorkflows(all));

		const result = await svc.setActionsPermissions(OWNER, REPO, { maxWorkflows: 100 }, TOKEN);

		expect(result.seenIds).toHaveLength(100);
		expect(result.truncated).toBe(false);
	});

	it('defaults the cap to 100 when the caller names none', async () => {
		listWorkflowsMock.mockImplementation(pagedWorkflows(workflows(150)));

		const result = await svc.setActionsPermissions(OWNER, REPO, {}, TOKEN);

		expect(result.seenIds).toHaveLength(100);
		expect(result.truncated).toBe(true);
	});

	it('cannot be turned off by passing a cap of zero', async () => {
		// A cap of 0 would silently make hygiene a no-op that reports success, so a
		// value that is not a positive whole number falls back to the default.
		listWorkflowsMock.mockImplementation(pagedWorkflows(workflows(150)));

		const result = await svc.setActionsPermissions(OWNER, REPO, { maxWorkflows: 0 }, TOKEN);

		expect(result.seenIds).toHaveLength(100);
		expect(result.truncated).toBe(true);
	});

	it('stops mid-page when the cap lands inside one, and says so', async () => {
		const all = workflows(60);
		listWorkflowsMock.mockImplementation(pagedWorkflows(all));

		const result = await svc.setActionsPermissions(OWNER, REPO, { maxWorkflows: 50 }, TOKEN);

		expect(result.seenIds).toEqual(all.slice(0, 50).map((workflow) => workflow.id));
		expect(result.truncated).toBe(true);
		// Nothing to peek at: the page itself answered.
		expect(listWorkflowsMock).toHaveBeenCalledTimes(1);
	});

	it('reads every page when the repository is below the cap', async () => {
		const all = workflows(150);
		listWorkflowsMock.mockImplementation(pagedWorkflows(all));

		const result = await svc.setActionsPermissions(OWNER, REPO, { maxWorkflows: 250 }, TOKEN);

		expect(result.seenIds).toEqual(all.map((workflow) => workflow.id));
		expect(result.truncated).toBe(false);
	});

	it('raises the typed error when a listing page fails', async () => {
		listWorkflowsMock.mockRejectedValue(statusError(403, 'Resource not accessible by integration'));

		await expect(svc.setActionsPermissions(OWNER, REPO, {}, TOKEN)).rejects.toMatchObject({
			reason: 'permission_missing',
			status: 403,
			details: { permission: 'actions' }
		});
	});
});

describe('GitHubApiService.setActionsPermissions — the allowlist and the skip ids (FR-27)', () => {
	it('keeps every workflow the allowlist names and disables the rest', async () => {
		listWorkflowsMock.mockImplementation(
			pagedWorkflows([
				{ id: 1, path: BUILD_PATH, state: 'active' },
				{ id: 2, path: DEPLOY_PATH, state: 'active' },
				{ id: 3, path: OTHER_PATH, state: 'active' }
			])
		);

		const result = await svc.setActionsPermissions(OWNER, REPO, { disableWorkflowsExcept: [BUILD_PATH] }, TOKEN);

		expect(disabledIds()).toEqual([2, 3]);
		expect(result.disabled).toEqual([
			{ id: 2, path: DEPLOY_PATH },
			{ id: 3, path: OTHER_PATH }
		]);
		expect(result.kept).toEqual([{ id: 1, path: BUILD_PATH }]);
		expect(result.enabled).toEqual([]);
		expect(result.seenIds).toEqual([1, 2, 3]);
	});

	it('never touches a workflow listed in skipWorkflowIds — not even to disable it', async () => {
		listWorkflowsMock.mockImplementation(
			pagedWorkflows([
				{ id: 1, path: BUILD_PATH, state: 'active' },
				{ id: 7, path: OTHER_PATH, state: 'active' },
				{ id: 8, path: DEPLOY_PATH, state: 'active' }
			])
		);

		const result = await svc.setActionsPermissions(
			OWNER,
			REPO,
			{ disableWorkflowsExcept: [BUILD_PATH], skipWorkflowIds: [7] },
			TOKEN
		);

		expect(disabledIds()).toEqual([8]);
		expect(enabledIds()).toEqual([]);
		// The skipped id was LOOKED AT — that is what `seenIds` is for — and left alone.
		expect(result.seenIds).toEqual([1, 7, 8]);
		expect(result.kept).toEqual([{ id: 1, path: BUILD_PATH }]);
	});

	it('never enables a workflow listed in skipWorkflowIds', async () => {
		listWorkflowsMock.mockImplementation(
			pagedWorkflows([{ id: 7, path: DEPLOY_PATH, state: 'disabled_manually' }])
		);

		const result = await svc.setActionsPermissions(
			OWNER,
			REPO,
			{ enableWorkflows: [DEPLOY_PATH], skipWorkflowIds: [7] },
			TOKEN
		);

		expect(enabledIds()).toEqual([]);
		expect(result.enabled).toEqual([]);
		expect(result.seenIds).toEqual([7]);
	});

	it('leaves an already-disabled workflow alone and does not report it as kept', async () => {
		listWorkflowsMock.mockImplementation(
			pagedWorkflows([
				{ id: 1, path: BUILD_PATH, state: 'disabled_manually' },
				{ id: 2, path: DEPLOY_PATH, state: 'active' }
			])
		);

		const result = await svc.setActionsPermissions(OWNER, REPO, { disableWorkflowsExcept: [BUILD_PATH] }, TOKEN);

		expect(disabledIds()).toEqual([2]);
		expect(result.kept).toEqual([]);
		expect(result.disabled).toEqual([{ id: 2, path: DEPLOY_PATH }]);
	});

	it('keeps every active workflow when no allowlist is given', async () => {
		listWorkflowsMock.mockImplementation(
			pagedWorkflows([
				{ id: 1, path: BUILD_PATH, state: 'active' },
				{ id: 2, path: DEPLOY_PATH, state: 'active' }
			])
		);

		const result = await svc.setActionsPermissions(OWNER, REPO, {}, TOKEN);

		expect(disabledIds()).toEqual([]);
		expect(result.kept).toEqual([
			{ id: 1, path: BUILD_PATH },
			{ id: 2, path: DEPLOY_PATH }
		]);
	});
});

describe('GitHubApiService.setActionsPermissions — enableWorkflows enables only its paths', () => {
	it('enables exactly the listed paths, whatever state they are in', async () => {
		listWorkflowsMock.mockImplementation(
			pagedWorkflows([
				{ id: 1, path: OTHER_PATH, state: 'disabled_manually' },
				{ id: 2, path: DEPLOY_PATH, state: 'disabled_inactivity' },
				{ id: 3, path: BUILD_PATH, state: 'active' }
			])
		);

		const result = await svc.setActionsPermissions(OWNER, REPO, { enableWorkflows: [BUILD_PATH] }, TOKEN);

		// Only the listed path — the two unpublished ones stay disabled.
		expect(enabledIds()).toEqual([3]);
		expect(result.enabled).toEqual([{ id: 3, path: BUILD_PATH }]);
		expect(result.kept).toEqual([]);
		expect(result.disabled).toEqual([]);
	});

	it('re-enables a workflow an earlier hygiene pass disabled', async () => {
		// The case the parameter exists for: hygiene disabled everything but the
		// build workflow, and APW-05 now needs the deploy workflow back.
		listWorkflowsMock.mockImplementation(
			pagedWorkflows([{ id: 2, path: DEPLOY_PATH, state: 'disabled_manually' }])
		);

		const result = await svc.setActionsPermissions(OWNER, REPO, { enableWorkflows: [DEPLOY_PATH] }, TOKEN);

		expect(enableWorkflowMock).toHaveBeenCalledWith({ owner: OWNER, repo: REPO, workflow_id: 2 });
		expect(result.enabled).toEqual([{ id: 2, path: DEPLOY_PATH }]);
	});

	it('prefers the enable list over the disable allowlist when a path is in both', async () => {
		listWorkflowsMock.mockImplementation(
			pagedWorkflows([
				{ id: 1, path: BUILD_PATH, state: 'active' },
				{ id: 2, path: DEPLOY_PATH, state: 'active' }
			])
		);

		const result = await svc.setActionsPermissions(
			OWNER,
			REPO,
			{ enableWorkflows: [DEPLOY_PATH], disableWorkflowsExcept: [BUILD_PATH] },
			TOKEN
		);

		expect(enabledIds()).toEqual([2]);
		expect(disabledIds()).toEqual([]);
		expect(result.enabled).toEqual([{ id: 2, path: DEPLOY_PATH }]);
		expect(result.kept).toEqual([{ id: 1, path: BUILD_PATH }]);
	});
});

describe('GitHubApiService.setActionsPermissions — the repository switch', () => {
	it('sends the switch only when enabled is set, and reports the requested value', async () => {
		listWorkflowsMock.mockImplementation(pagedWorkflows([]));

		const result = await svc.setActionsPermissions(OWNER, REPO, { enabled: true }, TOKEN);

		expect(setRepoPermissionsMock).toHaveBeenCalledTimes(1);
		expect(setRepoPermissionsMock).toHaveBeenCalledWith({ owner: OWNER, repo: REPO, enabled: true });
		// Nothing to read back: the caller's own value is the repository's state now.
		expect(getRepoPermissionsMock).not.toHaveBeenCalled();
		expect(result.actionsEnabled).toBe(true);
	});

	it('reads the current switch — never assumes one — when enabled is omitted', async () => {
		getRepoPermissionsMock.mockResolvedValue({ data: { enabled: false } });
		listWorkflowsMock.mockImplementation(pagedWorkflows([]));

		const result = await svc.setActionsPermissions(OWNER, REPO, { disableWorkflowsExcept: [BUILD_PATH] }, TOKEN);

		expect(getRepoPermissionsMock).toHaveBeenCalledWith({ owner: OWNER, repo: REPO });
		expect(setRepoPermissionsMock).not.toHaveBeenCalled();
		expect(result.actionsEnabled).toBe(false);
	});

	it('sends the switch before reading a single workflow', async () => {
		listWorkflowsMock.mockImplementation(pagedWorkflows([]));

		await svc.setActionsPermissions(OWNER, REPO, { enabled: false }, TOKEN);

		expect(setRepoPermissionsMock.mock.invocationCallOrder[0]).toBeLessThan(
			listWorkflowsMock.mock.invocationCallOrder[0]
		);
	});

	it('names administration when the switch is refused', async () => {
		setRepoPermissionsMock.mockRejectedValue(statusError(403, 'Resource not accessible by personal access token'));

		await expect(svc.setActionsPermissions(OWNER, REPO, { enabled: true }, TOKEN)).rejects.toMatchObject({
			reason: 'permission_missing',
			status: 403,
			details: { permission: 'administration' }
		});
	});
});

describe('GitHubApiService.setActionsPermissions — a 403 stops the pass (ACC-02-08)', () => {
	it('names actions for a non-App refusal and stops disabling', async () => {
		listWorkflowsMock.mockImplementation(
			pagedWorkflows([
				{ id: 1, path: BUILD_PATH, state: 'active' },
				{ id: 2, path: OTHER_PATH, state: 'active' },
				{ id: 3, path: DEPLOY_PATH, state: 'active' }
			])
		);
		disableWorkflowMock
			.mockResolvedValueOnce({ data: {} })
			.mockRejectedValueOnce(statusError(403, 'You do not have permission to disable this workflow'));

		const error = await svc
			.setActionsPermissions(OWNER, REPO, { disableWorkflowsExcept: [] }, TOKEN)
			.catch((err) => err);

		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(error.reason).toBe('permission_missing');
		expect(error.status).toBe(403);
		expect(error.details).toEqual({ permission: 'actions' });
		// STOPPED: the first disable succeeded, the second was refused, and the third
		// workflow was never attempted at all.
		expect(disabledIds()).toEqual([1, 2]);
		expect(disableWorkflowMock).toHaveBeenCalledTimes(2);
	});

	it('names administration when the refusal is an App installation token', async () => {
		listWorkflowsMock.mockImplementation(pagedWorkflows([{ id: 2, path: OTHER_PATH, state: 'active' }]));
		disableWorkflowMock.mockRejectedValue(statusError(403, 'Resource not accessible by integration'));

		await expect(
			svc.setActionsPermissions(OWNER, REPO, { disableWorkflowsExcept: [] }, TOKEN)
		).rejects.toMatchObject({
			reason: 'permission_missing',
			status: 403,
			details: { permission: 'administration' }
		});
	});

	it('names the permission when an ENABLE is refused too', async () => {
		listWorkflowsMock.mockImplementation(
			pagedWorkflows([{ id: 5, path: DEPLOY_PATH, state: 'disabled_manually' }])
		);
		enableWorkflowMock.mockRejectedValue(statusError(403, 'Resource not accessible by integration'));

		await expect(
			svc.setActionsPermissions(OWNER, REPO, { enableWorkflows: [DEPLOY_PATH] }, TOKEN)
		).rejects.toMatchObject({ reason: 'permission_missing', details: { permission: 'administration' } });
	});

	it('does not launder a rate limit into a permission failure', async () => {
		// §4.3's permission row must not swallow the rows §4.2 classifies first: a
		// member who has to WAIT is not a member who has to grant a permission.
		listWorkflowsMock.mockImplementation(pagedWorkflows([{ id: 2, path: OTHER_PATH, state: 'active' }]));
		disableWorkflowMock.mockRejectedValue(
			statusError(403, 'API rate limit exceeded', {
				'x-ratelimit-remaining': '0',
				'x-ratelimit-reset': '1700000000'
			})
		);

		const error = await svc
			.setActionsPermissions(OWNER, REPO, { disableWorkflowsExcept: [] }, TOKEN)
			.catch((err) => err);

		expect(error.reason).toBe('rate_limited');
		expect(error.details).toMatchObject({ retryAt: '2023-11-14T22:13:20.000Z' });
	});
});

describe('GitHubPlugin.setActionsPermissions — the capability pass-through (T20)', () => {
	it('reaches the hygiene pass through the plugin member APW-02 T22 will call', async () => {
		listWorkflowsMock.mockImplementation(pagedWorkflows([]));

		const result = await new GitHubPlugin().setActionsPermissions(OWNER, REPO, { enabled: true }, TOKEN);

		expect(setRepoPermissionsMock).toHaveBeenCalledWith({ owner: OWNER, repo: REPO, enabled: true });
		expect(result).toEqual({
			actionsEnabled: true,
			disabled: [],
			kept: [],
			enabled: [],
			seenIds: [],
			truncated: false
		});
	});
});
