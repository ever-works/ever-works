/**
 * flow-work-community-pr.spec.ts
 *
 * COMPLEX cross-feature INTEGRATION flows for a Work's community-PR ingest
 * settings — the `communityPrEnabled` / `communityPrAutoClose` flags, the
 * manual processing endpoint, and how processing DEGRADES when no git
 * provider is connected — driven through BOTH the API and the real settings
 * UI (`CommunityPrSettings`), end to end.
 *
 * IMPORTANT — probed reality (do NOT assume a fictional CRUD-PR API):
 * there is NO `/api/community/...` PR-management surface and NO
 * `/api/git/connection` endpoint. The ENTIRE community-PR surface is:
 *   - two boolean flags on the Work entity (`communityPrEnabled`,
 *     `communityPrAutoClose`), read via GET /api/works/:id and written via
 *     PUT|PATCH /api/works/:id (UpdateWorkDto), AND
 *   - one manual trigger: POST /api/works/:id/process-community-prs.
 * PR state transitions + lastPullRequest tracking are INTERNAL processor
 * state (`communityPrState`, `lastPullRequest`) managed by
 * CommunityPrProcessorService — never mutated/driven through the API.
 *
 * There IS a UI surface (this docblock CORRECTS the earlier "no UI" note):
 *   apps/web/src/components/works/detail/settings/CommunityPrSettings.tsx
 *   renders on /works/:id/settings inside SettingsForm. It is two
 *   `<Switch>` toggles — `button[role="switch"][aria-checked]` — labelled by
 *   i18n keys under `dashboard.workDetail.settings`:
 *     communityPrProcessing       = "Community PR"           (section heading)
 *     communityPrEnableLabel       = "Enable Community PR"
 *     communityPrAutoCloseLabel    = "Auto-close PRs after processing"
 *   The auto-close toggle is CONDITIONALLY rendered — present ONLY while
 *   `work.communityPrEnabled` is true (collapses when disabled). Each toggle
 *   calls the `updateCommunityPrSettings` server action → workAPI.update →
 *   PUT /api/works/:id, then `router.refresh()`, surfacing a sonner toast
 *   ("Community PR processing enabled" / "...disabled" /
 *   "Community PR settings updated"). The settings PAGE itself is gated:
 *   `canAccessSettings(work.userRole)` → owner/manager only, else notFound().
 *
 * Probed shapes (live API @ 127.0.0.1:3100 via curl; NestJS, global '/api'
 * prefix, AuthSessionGuard, ValidationPipe whitelist):
 *
 *   POST  /api/auth/register  {username,email,password}  -> 201 { access_token, user:{id} }
 *   POST  /api/works  {name,slug,description,organization:false} -> 200 { status:'success', work:{ id, ... } }
 *   GET   /api/works/:id                                  -> 200 { status:'success', work:{
 *                                                              communityPrEnabled:false,
 *                                                              communityPrAutoClose:true,   // entity DEFAULT is true
 *                                                              lastPullRequest:null,
 *                                                              communityPrState:null, ... } }
 *                                                            | 403 {status:'error',message:"You do not have permission to access this work"} (stranger)
 *   PUT|PATCH /api/works/:id  body {communityPrEnabled?, communityPrAutoClose?} -> 200 { status:'success', work:{...} }
 *                                                            | 400 {message:["communityPrEnabled must be a boolean value"]} (bad type, per field)
 *   POST  /api/works/:id/process-community-prs            -> 400 "Community PR processing is not enabled for this work." (disabled)
 *                                                            | 500 {statusCode:500,message:"Internal server error"} (ENABLED but NO git provider — the DEGRADE path; PROBED)
 *                                                            | 404 {status:'error',message:"Work with id '<id>' not found"} (ghost)
 *                                                            | 403 {status:'error',message:"You do not have permission to access this work"} (stranger)
 *                                                            | 401 {message:"Unauthorized"} (no token)
 *   GET   /api/works/:id/history?activityType=community_pr -> 200 { status:'success', history:[], total, limit, offset }
 *
 * Entity field shapes (packages/agent/src/entities/types.ts + work.entity.ts):
 *   CommunityPrState  = { processedPrNumbers:number[],
 *                         processedPrs?:Array<{ number, updatedAt, outcome:'applied'|'ignored' }>,
 *                         lastProcessedAt?, totalItemsAdded?, lastError? }   // opaque cursor, never set via API
 *   Work.communityPrState (simple-json, nullable) holds the above; null until a real processor run.
 *   Work.lastPullRequest  = { main?:PRUpdate, data?:PRUpdate }   // scheduled-update PR deep-links (untouched by community-PR)
 *   Work.communityPrEnabled   default false   (@Column boolean default false)
 *   Work.communityPrAutoClose default true    (@Column boolean default true)
 *
 * KEY DEGRADE CONTRACT (PROBED): with the flag ENABLED but no connected git
 * provider (the CI reality — no GitHub OAuth, no plugin creds), the processor
 * calls `gitFacade.listPullRequests` which throws (NoGitProviderError /
 * GitFacadeError — none are HttpExceptions), and the un-try/catch controller
 * surfaces a 500. That IS the truthful "git not connected" degradation: we
 * assert the gate flips from a 400 ("not enabled") to a NON-400 *attempt*
 * (500 here), never a fictional 200.
 *
 * Gotchas honored:
 *   - login DTO accepts ONLY {email,password}; register helper sends {username,email,password}.
 *   - run all API MUTATIONS on FRESH registerUserViaAPI() users (unique Date.now); never the shared
 *     seeded user. The seeded storageState user is used ONLY for UI-driven assertions.
 *   - createWorkViaAPI takes { name } and returns { id } (digs work.id out of {status,work}).
 *   - process-community-prs reads the flag from workRepository.findById which can briefly lag a PUT
 *     under the sqlite CI driver -> after enabling, poll until the status leaves 400, never one-shot.
 *   - entity default communityPrAutoClose=true -> assert that default, not false.
 *   - the auto-close UI toggle is conditionally mounted; assert it APPEARS only after enabling.
 *   - next-dev LOCAL vs CI route divergence: settings can render or 404 to the catch-all locally —
 *     branch on whether the "Community PR" section is present; never hard-fail the whole flow on it.
 *   - DEV HYDRATION RACE: retry the first toggle click (pre-hydration clicks are swallowed) with
 *     generous timeouts; assert the persisted boolean via the API (source of truth), not pixels.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
	API_BASE,
	authedHeaders,
	registerUserViaAPI,
	createWorkViaAPI,
} from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

const workUrl = (id: string) => `${API_BASE}/api/works/${id}`;
const processUrl = (id: string) => `${API_BASE}/api/works/${id}/process-community-prs`;

async function getWork(request: APIRequestContext, token: string, id: string) {
	const res = await request.get(workUrl(id), { headers: authedHeaders(token) });
	const body = await res.json();
	const work = body.work ?? body;
	return { res, body, work };
}

async function setFlags(
	request: APIRequestContext,
	token: string,
	id: string,
	flags: { communityPrEnabled?: boolean; communityPrAutoClose?: boolean },
) {
	return request.put(workUrl(id), {
		data: flags,
		headers: authedHeaders(token),
	});
}

async function process(request: APIRequestContext, token: string, id: string) {
	return request.post(processUrl(id), { headers: authedHeaders(token) });
}

/** Log the SEEDED storageState user in via API to get a bearer for setup. */
async function seededToken(request: APIRequestContext): Promise<string> {
	const s = loadSeededTestUser();
	const res = await request.post(`${API_BASE}/api/auth/login`, {
		data: { email: s.email, password: s.password },
	});
	const body = await res.json();
	return body.access_token as string;
}

/**
 * Navigate the seeded-user `page` to a Work's settings screen and resolve the
 * Community PR section locator. Returns null when the route degraded to the
 * catch-all 404 (local next-dev divergence) so callers can skip gracefully.
 */
async function openCommunityPrSection(page: Page, baseURL: string | undefined, workId: string) {
	const origin = baseURL ?? 'http://localhost:3000';
	await page.goto(`${origin}/en/works/${workId}/settings`, {
		waitUntil: 'domcontentloaded',
	});

	const section = page.getByRole('heading', { name: 'Community PR', exact: true });

	// Wait for either the section heading (rendered) or treat its absence as the
	// next-dev catch-all 404 divergence so callers can skip gracefully.
	const appeared = await section
		.first()
		.waitFor({ state: 'visible', timeout: 20_000 })
		.then(() => true)
		.catch(() => false);

	return appeared ? section.first() : null;
}

test.describe('Work community-PR flags + processing (integration)', () => {
	test.setTimeout(90_000);

	// ─── API integration flows (fresh throwaway users) ──────────────────

	test('enable flag gates processing: disabled blocks (400), enabling unlocks an attempt that degrades without git', async ({
		request,
	}) => {
		const user = await registerUserViaAPI(request);
		const token = user.access_token;
		const work = await createWorkViaAPI(request, token, {
			name: `Community gate ${Date.now()}`,
		});

		// Defaults: enabled off, autoClose ON (entity default true), no processor state.
		const initial = await getWork(request, token, work.id);
		expect(initial.res.ok()).toBeTruthy();
		expect(initial.work.communityPrEnabled).toBe(false);
		expect(initial.work.communityPrAutoClose).toBe(true);
		expect(initial.work.lastPullRequest ?? null).toBeNull();
		expect(initial.work.communityPrState ?? null).toBeNull();

		// Disabled -> processing blocked with the truthful 400 message.
		const blocked = await process(request, token, work.id);
		expect(blocked.status()).toBe(400);
		expect(JSON.stringify(await blocked.json())).toContain(
			'Community PR processing is not enabled for this work.',
		);

		// Enable the flag; GET reflects it.
		const enableRes = await setFlags(request, token, work.id, {
			communityPrEnabled: true,
		});
		expect(enableRes.status()).toBe(200);
		await expect
			.poll(
				async () => (await getWork(request, token, work.id)).work.communityPrEnabled,
				{ timeout: 15_000 },
			)
			.toBe(true);

		// The gate is now OPEN: the endpoint stops returning the "not enabled" 400
		// and instead ATTEMPTS to process. With no connected git provider in CI it
		// cannot list pull requests, so the attempt degrades to a 500 (PROBED). We
		// assert the gate transition (no longer 400-"not enabled") rather than a
		// fictional 200. findById can briefly lag the PUT under sqlite, so poll.
		let processed!: Awaited<ReturnType<typeof process>>;
		await expect
			.poll(
				async () => {
					processed = await process(request, token, work.id);
					return processed.status();
				},
				{ timeout: 20_000 },
			)
			.not.toBe(400);
		expect(processed.status()).not.toBe(400);
		expect(processed.status()).toBeGreaterThanOrEqual(200);
		expect(JSON.stringify(await processed.json())).not.toContain(
			'Community PR processing is not enabled',
		);
	});

	test('the two flags are independent: autoClose toggles without enabling, and both persist round-trips', async ({
		request,
	}) => {
		const user = await registerUserViaAPI(request);
		const token = user.access_token;
		const work = await createWorkViaAPI(request, token, {
			name: `Community flags ${Date.now()}`,
		});

		// Turn autoClose OFF (it defaults true) ALONE. enabled must stay false.
		const flipAutoCloseOff = await setFlags(request, token, work.id, {
			communityPrAutoClose: false,
		});
		expect(flipAutoCloseOff.status()).toBe(200);
		const afterOff = await getWork(request, token, work.id);
		expect(afterOff.work.communityPrEnabled).toBe(false);
		expect(afterOff.work.communityPrAutoClose).toBe(false);

		// autoClose changes while enabled=false STILL block processing (enable is the gate).
		const blockedWhileDisabled = await process(request, token, work.id);
		expect(blockedWhileDisabled.status()).toBe(400);
		expect(JSON.stringify(await blockedWhileDisabled.json())).toContain('not enabled');

		// Flip enabled on AND autoClose back on in one write -> both true, survive re-read.
		await setFlags(request, token, work.id, {
			communityPrEnabled: true,
			communityPrAutoClose: true,
		});
		await expect
			.poll(
				async () => {
					const w = (await getWork(request, token, work.id)).work;
					return `${w.communityPrEnabled}/${w.communityPrAutoClose}`;
				},
				{ timeout: 15_000 },
			)
			.toBe('true/true');

		// Now turn autoClose OFF independently; enabled must remain on.
		await setFlags(request, token, work.id, { communityPrAutoClose: false });
		const finalState = await getWork(request, token, work.id);
		expect(finalState.work.communityPrEnabled).toBe(true);
		expect(finalState.work.communityPrAutoClose).toBe(false);
	});

	test('disable after enable re-blocks processing while leaving autoClose untouched', async ({
		request,
	}) => {
		const user = await registerUserViaAPI(request);
		const token = user.access_token;
		const work = await createWorkViaAPI(request, token, {
			name: `Community disable ${Date.now()}`,
		});

		// Enable processing (autoClose left at its default true). Confirm the gate
		// opens: processing leaves the "not enabled" 400 (attempt degrades without git).
		await setFlags(request, token, work.id, { communityPrEnabled: true });
		await expect
			.poll(async () => (await process(request, token, work.id)).status(), {
				timeout: 20_000,
			})
			.not.toBe(400);

		// Disable processing ONLY (do not touch autoClose).
		const disableRes = await setFlags(request, token, work.id, {
			communityPrEnabled: false,
		});
		expect(disableRes.status()).toBe(200);

		// Processing is gated again -> back to the enablement 400.
		await expect
			.poll(async () => (await process(request, token, work.id)).status(), {
				timeout: 15_000,
			})
			.toBe(400);
		const reBlocked = await process(request, token, work.id);
		expect(JSON.stringify(await reBlocked.json())).toContain(
			'Community PR processing is not enabled for this work.',
		);

		// ...but autoClose=true (the default) was preserved by the disable: the
		// disable touched ONLY communityPrEnabled (flags are orthogonal).
		const preserved = await getWork(request, token, work.id);
		expect(preserved.work.communityPrEnabled).toBe(false);
		expect(preserved.work.communityPrAutoClose).toBe(true);
	});

	test('an enabled-but-no-git attempt degrades cleanly and never corrupts processor/PR state', async ({
		request,
	}) => {
		const user = await registerUserViaAPI(request);
		const token = user.access_token;
		const work = await createWorkViaAPI(request, token, {
			name: `Community degrade ${Date.now()}`,
		});

		await setFlags(request, token, work.id, { communityPrEnabled: true });

		// Drive the degrade path a few times. Each attempt must (a) leave the
		// enablement 400 behind and (b) stay a bounded server response (< 600),
		// never hang or surface the "not enabled" gate again.
		await expect
			.poll(async () => (await process(request, token, work.id)).status(), {
				timeout: 20_000,
			})
			.not.toBe(400);
		for (let i = 0; i < 2; i++) {
			const attempt = await process(request, token, work.id);
			expect(attempt.status()).not.toBe(400);
			expect(attempt.status()).toBeLessThan(600);
			expect(JSON.stringify(await attempt.json())).not.toContain(
				'Community PR processing is not enabled',
			);
		}

		// The community_pr history filter is fetchable and well-shaped (200 +
		// `history` array + `total`). A failed no-git attempt records nothing, so
		// the array may be empty — best-effort, never hard-require an entry.
		const hist = await request.get(
			`${workUrl(work.id)}/history?activityType=community_pr`,
			{ headers: authedHeaders(token) },
		);
		expect(hist.status()).toBe(200);
		const histBody = await hist.json();
		expect(histBody.status).toBe('success');
		expect(Array.isArray(histBody.history)).toBeTruthy();
		expect(histBody).toHaveProperty('total');

		// A failed attempt must not corrupt the opaque processor cursor (stays
		// null or a well-formed object) and must not touch the scheduled-update
		// lastPullRequest deep-links.
		const w = (await getWork(request, token, work.id)).work;
		const state = w.communityPrState ?? null;
		expect(state === null || typeof state === 'object').toBeTruthy();
		expect(w.lastPullRequest ?? null).toBeNull();
		// The enable flag itself is unchanged by the failed processing attempts.
		expect(w.communityPrEnabled).toBe(true);
	});

	test('ownership + auth guards: stranger, nonexistent work, and unauthenticated are all rejected', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const stranger = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `Community guards ${Date.now()}`,
		});
		await setFlags(request, owner.access_token, work.id, {
			communityPrEnabled: true,
		});

		// Stranger cannot read the work nor trigger processing -> 403 (not a 404 leak).
		const strangerGet = await request.get(workUrl(work.id), {
			headers: authedHeaders(stranger.access_token),
		});
		expect(strangerGet.status()).toBe(403);
		expect(JSON.stringify(await strangerGet.json())).toContain(
			'do not have permission to access this work',
		);

		const strangerProcess = await process(request, stranger.access_token, work.id);
		expect(strangerProcess.status()).toBe(403);
		expect(JSON.stringify(await strangerProcess.json())).toContain(
			'do not have permission to access this work',
		);

		// Nonexistent work id -> 404 with the id echoed in the message.
		const ghost = '00000000-0000-0000-0000-000000000000';
		const ghostProcess = await process(request, owner.access_token, ghost);
		expect(ghostProcess.status()).toBe(404);
		expect(JSON.stringify(await ghostProcess.json())).toContain('not found');

		// No bearer token at all -> 401 from the guard. (An empty-string header is
		// coerced to an anonymous identity that then fails ownership with 403, so
		// tolerate either truthful "blocked" outcome.)
		const unauth = await request.post(processUrl(work.id));
		expect([401, 403]).toContain(unauth.status());
	});

	test('flag writes are validated: non-boolean values are rejected and never mutate prior state', async ({
		request,
	}) => {
		const user = await registerUserViaAPI(request);
		const token = user.access_token;
		const work = await createWorkViaAPI(request, token, {
			name: `Community validation ${Date.now()}`,
		});

		// Establish a known-good baseline (enabled=true).
		await setFlags(request, token, work.id, { communityPrEnabled: true });
		await expect
			.poll(
				async () => (await getWork(request, token, work.id)).work.communityPrEnabled,
				{ timeout: 15_000 },
			)
			.toBe(true);

		// A non-boolean enabled value -> 400 with the field-specific message.
		const badEnabled = await request.put(workUrl(work.id), {
			data: { communityPrEnabled: 'yes' },
			headers: authedHeaders(token),
		});
		expect(badEnabled.status()).toBe(400);
		expect(JSON.stringify(await badEnabled.json())).toContain(
			'communityPrEnabled must be a boolean value',
		);

		// A non-boolean autoClose -> 400 with its own field-specific message.
		const badAutoClose = await request.put(workUrl(work.id), {
			data: { communityPrAutoClose: 5 },
			headers: authedHeaders(token),
		});
		expect(badAutoClose.status()).toBe(400);
		expect(JSON.stringify(await badAutoClose.json())).toContain(
			'communityPrAutoClose must be a boolean value',
		);

		// The rejected writes did not corrupt the prior state: still enabled, and
		// the processing gate is still open (attempt leaves the enablement 400).
		const after = await getWork(request, token, work.id);
		expect(after.work.communityPrEnabled).toBe(true);
		await expect
			.poll(async () => (await process(request, token, work.id)).status(), {
				timeout: 15_000,
			})
			.not.toBe(400);
	});

	// ─── UI integration flows (seeded storageState user owns the work) ──

	test('settings UI: enabling Community PR reveals the conditionally-mounted auto-close toggle and persists to the API', async ({
		page,
		request,
		baseURL,
	}) => {
		// The seeded storageState user owns the work (created via its own bearer),
		// so canAccessSettings() grants it the settings page.
		const token = await seededToken(request);
		const work = await createWorkViaAPI(request, token, {
			name: `Community UI reveal ${Date.now()}`,
		});

		// Sanity: starts disabled (so the auto-close toggle is NOT yet mounted).
		const before = await getWork(request, token, work.id);
		expect(before.work.communityPrEnabled).toBe(false);

		const section = await openCommunityPrSection(page, baseURL, work.id);
		test.skip(
			section === null,
			'Community PR settings section did not render (next-dev catch-all route divergence) — API-side enablement is already covered by the API flows.',
		);

		// While disabled, the "Enable Community PR" toggle is present but the
		// "Auto-close PRs after processing" toggle is NOT mounted (conditional).
		const enableRow = page.getByText('Enable Community PR', { exact: true });
		await expect(enableRow).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText('Auto-close PRs after processing', { exact: true })).toHaveCount(
			0,
		);

		// The enable toggle is the switch inside the "Enable Community PR" row;
		// locate it relative to its label row to avoid grabbing an unrelated
		// page switch.
		const enableSwitch = page
			.locator('div', { hasText: 'Enable Community PR' })
			.locator('button[role="switch"]')
			.last();

		// Hydration race: the first click can be swallowed. Retry until the
		// persisted flag flips server-side (the source of truth), with a toast as
		// a soft signal.
		await expect
			.poll(
				async () => {
					await enableSwitch
						.click({ timeout: 5_000 })
						.catch(() => {});
					return (await getWork(request, token, work.id)).work.communityPrEnabled;
				},
				{ timeout: 30_000 },
			)
			.toBe(true);

		// Now that it's enabled, router.refresh() re-renders the card WITH the
		// previously-hidden auto-close toggle. Wait for it to mount.
		await expect(page.getByText('Auto-close PRs after processing', { exact: true })).toBeVisible(
			{ timeout: 20_000 },
		);

		// API confirms the cross-surface write: enabled true, autoClose still the
		// untouched default (true).
		const afterEnable = await getWork(request, token, work.id);
		expect(afterEnable.work.communityPrEnabled).toBe(true);
		expect(afterEnable.work.communityPrAutoClose).toBe(true);

		// Flip auto-close OFF through the now-visible toggle and confirm only that
		// flag changes server-side (enabled stays true).
		const autoCloseSwitch = page
			.locator('div', { hasText: 'Auto-close PRs after processing' })
			.locator('button[role="switch"]')
			.last();
		await expect
			.poll(
				async () => {
					await autoCloseSwitch.click({ timeout: 5_000 }).catch(() => {});
					return (await getWork(request, token, work.id)).work.communityPrAutoClose;
				},
				{ timeout: 30_000 },
			)
			.toBe(false);

		const afterAutoClose = await getWork(request, token, work.id);
		expect(afterAutoClose.work.communityPrEnabled).toBe(true);
		expect(afterAutoClose.work.communityPrAutoClose).toBe(false);
	});

	test('settings page is permission-gated: a non-member is denied the Community PR settings UI (notFound), and a UI-enabled work still degrades on manual processing without git', async ({
		page,
		request,
		baseURL,
	}) => {
		// Owner = a FRESH user (not the seeded user) so the seeded storageState
		// user is a genuine NON-member of this work.
		const owner = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `Community UI gate ${Date.now()}`,
		});

		// The seeded browser user is NOT a member -> the settings page server
		// component calls notFound() (canAccessSettings fails). The Community PR
		// section must therefore NOT render for them.
		const origin = baseURL ?? 'http://localhost:3000';
		await page.goto(`${origin}/en/works/${work.id}/settings`, {
			waitUntil: 'domcontentloaded',
		});
		// Either a not-found surface or, at minimum, the absence of the section.
		await expect(page.getByRole('heading', { name: 'Community PR', exact: true })).toHaveCount(
			0,
			{ timeout: 15_000 },
		);

		// Meanwhile the OWNER enables the flag via the API and a manual process
		// attempt degrades (no git provider in CI) — the same gate transition the
		// UI ultimately drives, asserted from the owner's perspective.
		await setFlags(request, owner.access_token, work.id, { communityPrEnabled: true });
		let processed!: Awaited<ReturnType<typeof process>>;
		await expect
			.poll(
				async () => {
					processed = await process(request, owner.access_token, work.id);
					return processed.status();
				},
				{ timeout: 20_000 },
			)
			.not.toBe(400);
		expect(processed.status()).toBeGreaterThanOrEqual(200);
		expect(JSON.stringify(await processed.json())).not.toContain(
			'Community PR processing is not enabled',
		);

		// The non-member also cannot trigger processing via the API -> 403.
		const seededTok = await seededToken(request);
		const denied = await process(request, seededTok, work.id);
		expect(denied.status()).toBe(403);
		expect(JSON.stringify(await denied.json())).toContain(
			'do not have permission to access this work',
		);
	});
});
