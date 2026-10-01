import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitProviderRequestError } from '@ever-works/plugin/git';

/**
 * APW-02 T21 — `GitHubApiService.createWebhook` / `deleteWebhook` (plan §4.3,
 * FR-55).
 *
 * FR-55 asks for one thing that is easy to get wrong twice: a webhook installed
 * **idempotently**. Install has to converge on the hook that is already there —
 * identified by its URL, because that is the only field the caller and the
 * provider both know — instead of adding a second one that has the receiver
 * verifying two signatures for every event; and removal has to treat "it is not
 * there" as the success it is, so a retried flow does not fail on a hook a
 * previous run already removed.
 *
 * The rest of the suite is about the three refusals decided BEFORE GitHub is
 * called (URL, secret, events — see `webhookRefusal`) and about the one secret
 * that must never travel on a thrown error. That last assertion is deliberately
 * adversarial: the mocked provider echoes the submitted body back in its error
 * message, which is the worst case a real one can produce, and the thrown error
 * still must not contain the secret anywhere a logger would reach.
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

const listWebhooksMock = vi.fn();
const createWebhookMock = vi.fn();
const updateWebhookMock = vi.fn();
const deleteWebhookMock = vi.fn();

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = {
			repos: {
				listWebhooks: (...args: unknown[]) => listWebhooksMock(...args),
				createWebhook: (...args: unknown[]) => createWebhookMock(...args),
				updateWebhook: (...args: unknown[]) => updateWebhookMock(...args),
				deleteWebhook: (...args: unknown[]) => deleteWebhookMock(...args)
			}
		};
		constructor(public opts: unknown) {}
	}

	class FakeRequestError extends Error {
		status?: number;
		response?: { data?: unknown; headers?: Record<string, string | number> };
		/** Octokit keeps the request it made, body included — the leak this suite pins. */
		request?: { method?: string; url?: string; body?: unknown };
	}

	return { Octokit: FakeOctokit, RequestError: FakeRequestError };
});

const { RequestError } = await import('octokit');
const { GitHubApiService } = await import('../github-api.service.js');
const { GitHubPlugin } = await import('../github.plugin.js');

const OWNER = 'ever-works';
const REPO = 'app-data';
const TOKEN = 'ghp_secret';
const HOOK_URL = 'https://api.ever.works/api/ingest/github/events';
const OTHER_URL = 'https://hooks.example.com/other';
const SECRET = 'whsec_super_secret_value';
const EVENTS = ['push', 'pull_request'];
const HOOK_ID = 42;

/** A GitHub status error, shaped the way Octokit raises one. */
function statusError(status: number, message: string): Error {
	const ctor = RequestError as unknown as new (message: string) => Error;
	const error = new ctor(message);
	const shaped = error as Error & { status?: number; response?: unknown };
	shaped.status = status;
	shaped.response = { data: { message }, headers: {} };
	return error;
}

/** A hook payload with only the fields the lookup reads. */
function hook(id: number, url: string) {
	return { id, config: { url, content_type: 'json', insecure_ssl: '0' }, events: [...EVENTS], active: true };
}

/** `listWebhooks`, served page by page from a fixed listing. */
function pagedHooks(all: ReturnType<typeof hook>[]) {
	return vi.fn(async ({ page, per_page }: { page?: number; per_page?: number }) => {
		const size = per_page ?? 30;
		const start = ((page ?? 1) - 1) * size;
		return { data: all.slice(start, start + size) };
	});
}

const input = (overrides: Record<string, unknown> = {}) => ({
	url: HOOK_URL,
	secret: SECRET,
	events: EVENTS,
	...overrides
});

let svc: InstanceType<typeof GitHubApiService>;

beforeEach(() => {
	svc = new GitHubApiService();
	listWebhooksMock.mockReset().mockResolvedValue({ data: [] });
	createWebhookMock.mockReset().mockResolvedValue({ data: hook(HOOK_ID, HOOK_URL) });
	updateWebhookMock.mockReset().mockResolvedValue({ data: hook(HOOK_ID, HOOK_URL) });
	deleteWebhookMock.mockReset().mockResolvedValue({ data: undefined });
});

describe('GitHubApiService.createWebhook — create when the URL is new', () => {
	it('creates the hook with the exact config, events and active flag', async () => {
		const result = await svc.createWebhook(OWNER, REPO, input(), TOKEN);

		expect(createWebhookMock).toHaveBeenCalledTimes(1);
		expect(createWebhookMock).toHaveBeenCalledWith({
			owner: OWNER,
			repo: REPO,
			config: { url: HOOK_URL, secret: SECRET, content_type: 'json', insecure_ssl: '0' },
			events: EVENTS,
			active: true
		});
		expect(result).toEqual({ id: HOOK_ID, created: true });
	});

	it('does not update anything when nothing matched', async () => {
		await svc.createWebhook(OWNER, REPO, input(), TOKEN);

		expect(updateWebhookMock).not.toHaveBeenCalled();
	});

	it('adds a hook alongside ones pointing elsewhere', async () => {
		listWebhooksMock.mockImplementation(pagedHooks([hook(1, OTHER_URL)]));

		const result = await svc.createWebhook(OWNER, REPO, input(), TOKEN);

		expect(updateWebhookMock).not.toHaveBeenCalled();
		expect(result.created).toBe(true);
	});
});

describe('GitHubApiService.createWebhook — idempotent by URL (FR-55)', () => {
	it('updates the hook already pointed at that URL instead of creating a second', async () => {
		listWebhooksMock.mockImplementation(pagedHooks([hook(7, OTHER_URL), hook(HOOK_ID, HOOK_URL)]));

		const result = await svc.createWebhook(OWNER, REPO, input(), TOKEN);

		expect(createWebhookMock).not.toHaveBeenCalled();
		expect(updateWebhookMock).toHaveBeenCalledTimes(1);
		expect(updateWebhookMock).toHaveBeenCalledWith({
			owner: OWNER,
			repo: REPO,
			hook_id: HOOK_ID,
			config: { url: HOOK_URL, secret: SECRET, content_type: 'json', insecure_ssl: '0' },
			events: EVENTS,
			active: true
		});
		expect(result).toEqual({ id: HOOK_ID, created: false });
	});

	it('creates once and updates on the second run — one hook, two answers', async () => {
		listWebhooksMock.mockResolvedValueOnce({ data: [] }).mockImplementation(pagedHooks([hook(HOOK_ID, HOOK_URL)]));

		const first = await svc.createWebhook(OWNER, REPO, input(), TOKEN);
		const second = await svc.createWebhook(OWNER, REPO, input(), TOKEN);

		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(createWebhookMock).toHaveBeenCalledTimes(1);
		expect(updateWebhookMock).toHaveBeenCalledTimes(1);
	});

	it('sends the caller events and secret on the update, so the hook converges', async () => {
		listWebhooksMock.mockImplementation(pagedHooks([hook(HOOK_ID, HOOK_URL)]));

		await svc.createWebhook(OWNER, REPO, input({ events: ['workflow_run'], secret: 'rotated' }), TOKEN);

		const body = updateWebhookMock.mock.calls[0][0] as { config: { secret: string }; events: string[] };
		expect(body.events).toEqual(['workflow_run']);
		expect(body.config.secret).toBe('rotated');
	});

	it('finds a hook that sits on a later page', async () => {
		const first = Array.from({ length: 100 }, (_, index) => hook(index + 1, `https://hooks.example.com/${index}`));
		listWebhooksMock.mockImplementation(pagedHooks([...first, hook(HOOK_ID, HOOK_URL)]));

		const result = await svc.createWebhook(OWNER, REPO, input(), TOKEN);

		expect(result).toEqual({ id: HOOK_ID, created: false });
		expect(listWebhooksMock.mock.calls.map((call) => (call[0] as { page: number }).page)).toEqual([1, 2]);
	});

	it('raises the typed error when the hook listing fails', async () => {
		listWebhooksMock.mockRejectedValue(statusError(403, 'Resource not accessible by integration'));

		await expect(svc.createWebhook(OWNER, REPO, input(), TOKEN)).rejects.toMatchObject({
			reason: 'permission_missing',
			status: 403,
			details: { permission: 'webhooks' }
		});
		expect(createWebhookMock).not.toHaveBeenCalled();
	});
});

describe('GitHubApiService.createWebhook — the refusals decided before any call', () => {
	it('refuses a loopback URL without calling GitHub', async () => {
		const error = await svc
			.createWebhook(OWNER, REPO, input({ url: 'http://127.0.0.1:3000/ingest' }), TOKEN)
			.catch((err) => err);

		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(error.reason).toBe('unprocessable');
		expect(error.status).toBe(422);
		expect(error.message).toBe('webhook_url_refused');
		expect(listWebhooksMock).not.toHaveBeenCalled();
		expect(createWebhookMock).not.toHaveBeenCalled();
	});

	it('refuses a cloud-metadata URL', async () => {
		const error = await svc
			.createWebhook(OWNER, REPO, input({ url: 'http://169.254.169.254/latest/meta-data/' }), TOKEN)
			.catch((err) => err);

		expect(error.message).toBe('webhook_url_refused');
		expect(listWebhooksMock).not.toHaveBeenCalled();
	});

	it('refuses a non-http scheme', async () => {
		const error = await svc
			.createWebhook(OWNER, REPO, input({ url: 'file:///etc/passwd' }), TOKEN)
			.catch((err) => err);

		expect(error.message).toBe('webhook_url_refused');
	});

	it('refuses an empty secret — FR-55 installs a SIGNED webhook', async () => {
		const error = await svc.createWebhook(OWNER, REPO, input({ secret: '   ' }), TOKEN).catch((err) => err);

		expect(error.message).toBe('webhook_secret_required');
		expect(createWebhookMock).not.toHaveBeenCalled();
	});

	it('refuses a hook that would fire on nothing', async () => {
		const error = await svc.createWebhook(OWNER, REPO, input({ events: [] }), TOKEN).catch((err) => err);

		expect(error.message).toBe('webhook_events_required');
		expect(createWebhookMock).not.toHaveBeenCalled();
	});
});

describe('GitHubApiService.createWebhook — the secret never travels on an error', () => {
	it('keeps the secret out of a failure the provider echoes it back in', async () => {
		// The worst case a provider can produce: GitHub quoting the body we sent.
		listWebhooksMock.mockRejectedValue(
			statusError(422, `Validation Failed: {"config":{"url":"${HOOK_URL}","secret":"${SECRET}"}}`)
		);

		const error: GitProviderRequestError = await svc.createWebhook(OWNER, REPO, input(), TOKEN).catch((err) => err);

		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(error.message).not.toContain(SECRET);
		// Anything a logger could reach — the message, the cause, the details bag.
		expect(
			JSON.stringify({ message: error.message, cause: String(error.cause), details: error.details })
		).not.toContain(SECRET);
		expect(String(error.cause)).toContain('[redacted]');
	});

	it('keeps the secret out of a create failure', async () => {
		createWebhookMock.mockRejectedValue(statusError(422, `Validation Failed: secret=${SECRET}`));

		const error = await svc.createWebhook(OWNER, REPO, input(), TOKEN).catch((err) => err);

		expect(error.message).not.toContain(SECRET);
		expect(JSON.stringify(String(error.cause))).not.toContain(SECRET);
	});

	it('still reports the classified reason and the webhooks permission', async () => {
		createWebhookMock.mockRejectedValue(statusError(403, 'Resource not accessible by integration'));

		const error = await svc.createWebhook(OWNER, REPO, input(), TOKEN).catch((err) => err);

		expect(error.reason).toBe('permission_missing');
		expect(error.status).toBe(403);
		expect(error.details).toEqual({ permission: 'webhooks' });
	});
});

describe('GitHubApiService.deleteWebhook — 404 is success (plan §4.3)', () => {
	it('deletes the hook by id', async () => {
		await svc.deleteWebhook(OWNER, REPO, HOOK_ID, TOKEN);

		expect(deleteWebhookMock).toHaveBeenCalledWith({ owner: OWNER, repo: REPO, hook_id: HOOK_ID });
	});

	it('treats a 404 as success — a retried delete does not fail', async () => {
		deleteWebhookMock.mockRejectedValue(statusError(404, 'Not Found'));

		await expect(svc.deleteWebhook(OWNER, REPO, HOOK_ID, TOKEN)).resolves.toBeUndefined();
	});

	it('raises the typed error, naming webhooks, on any other failure', async () => {
		deleteWebhookMock.mockRejectedValue(statusError(403, 'Resource not accessible by integration'));

		await expect(svc.deleteWebhook(OWNER, REPO, HOOK_ID, TOKEN)).rejects.toMatchObject({
			reason: 'permission_missing',
			status: 403,
			details: { permission: 'webhooks' }
		});
	});

	it('raises not_found only for the failures that are not a 404 (401)', async () => {
		deleteWebhookMock.mockRejectedValue(statusError(401, 'Bad credentials'));

		await expect(svc.deleteWebhook(OWNER, REPO, HOOK_ID, TOKEN)).rejects.toMatchObject({
			reason: 'unauthorized',
			status: 401
		});
	});
});

describe('GitHubPlugin webhook pass-through (T21)', () => {
	it('installs through the plugin member APW-02 T22 will call', async () => {
		const result = await new GitHubPlugin().createWebhook(OWNER, REPO, input(), TOKEN);

		expect(createWebhookMock).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ id: HOOK_ID, created: true });
	});

	it('removes through the plugin, a 404 included', async () => {
		deleteWebhookMock.mockRejectedValue(statusError(404, 'Not Found'));

		await expect(new GitHubPlugin().deleteWebhook(OWNER, REPO, HOOK_ID, TOKEN)).resolves.toBeUndefined();
		expect(deleteWebhookMock).toHaveBeenCalledWith({ owner: OWNER, repo: REPO, hook_id: HOOK_ID });
	});
});
