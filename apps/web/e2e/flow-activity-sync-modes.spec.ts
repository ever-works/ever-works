import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * flow-activity-sync-modes — the EW-120 DUAL-MODE Activity-Feed sync transport,
 * driven end-to-end through its real public surface.
 * ─────────────────────────────────────────────────────────────────────────────
 * A Work's `activitySyncMode` ∈ { 'pull' | 'push' | 'disabled' } selects HOW
 * website-side events (signups, item submissions, reports) reach the platform
 * Activity-Feed tab. This file orchestrates the WHOLE mode lifecycle — switch
 * the mode, watch the transport gates flip, and verify the
 * platformSyncLastSuccess/Error observability columns + the per-Work
 * pull-transport secret rotation.
 *
 * EVERY shape below was probed against the LIVE API (sqlite in-memory — the
 * exact CI driver) on a throwaway user before any assertion was written.
 *
 *   Mode column (Work entity, packages/agent/src/entities/work.entity.ts):
 *     activitySyncMode             default 'pull' (varchar(16))
 *     platformSyncLastSuccessAt    nullable timestamp (pull-mode observability)
 *     platformSyncLastErrorAt      nullable timestamp
 *     platformSyncLastErrorMessage nullable text
 *     platformSyncSecretEncrypted  AES-256-GCM ciphertext, NULL until rotate/deploy
 *     webhookSecretEncrypted       AES-256-GCM ciphertext, NULL until first deploy
 *
 *   Mode SWITCH (work-lifecycle.service writes the column DIRECTLY — NOT git-gated):
 *     PUT|PATCH /api/works/:id  { activitySyncMode:'pull'|'push'|'disabled' }
 *       → 200 { status:'success', work:{ … activitySyncMode } } + a
 *         `work.updated` activity row.
 *     invalid value ('bogus')  → 400 (class-validator @IsIn).
 *     GET /api/works/:id  → { status:'success', work:{ activitySyncMode, … } }.
 *
 *   PUSH-mode ingest (POST /api/activity-log/ingest, PlatformSecretGuard bearer):
 *     bearer = PLATFORM_API_SECRET_TOKEN (pinned in apps/api/.env).
 *     push   + valid bearer + valid DTO → 202 { id }.
 *     replay SAME (workId,eventId)       → 202 { id } SAME id (idempotent).
 *     pull/disabled mode                 → 409 { error:'mode-mismatch', mode, message }.
 *     missing bearer                     → 401 'Missing Bearer token'.
 *     wrong bearer                       → 401 'Invalid bearer token'.
 *     unknown work                       → 404 'Work <id> not found'.
 *     DTO: workId+eventId @IsUUID, actionType @IsEnum(WEBSITE_*),
 *          occurredAt @IsISO8601, summary @MaxLength(500), metadata <= 8 KiB.
 *          accepted actionTypes: website_user_registered, website_item_submitted,
 *          website_report_filed, website_report_resolved.
 *          summary>500 → 400; metadata>8KiB → 400.
 *
 *   PULL-mode rotate (POST /api/works/:id/activity-sync/rotate-secret):
 *     pull mode      → 200 { status:'success', redeployRequired:true }, provisions
 *                      platformSyncSecretEncrypted + a
 *                      `work.activity_sync.secret_rotated` activity row.
 *     push/disabled  → 409 { error:'mode-mismatch', mode, message }.
 *     non-owner      → 403 'You do not have permission to access this work'.
 *     unknown/non-uuid work → 404 "Work with id '<id>' not found".
 *     unauth         → 401.
 *
 *   PULL-mode feed observability (GET /api/works/:id/activity-feed):
 *     pull mode  → composes the directory-site pull. In CI the Work has no
 *                  deployed URL, so the pull DEGRADES:
 *                  degraded.directorySite = { reason:'not_provisioned',
 *                    detail:'Work has no deployed website URL', lastSuccessAt }.
 *                  Async (best-effort) writes platformSyncLastErrorAt +
 *                  platformSyncLastErrorMessage='not_provisioned: …' and leaves
 *                  platformSyncLastSuccessAt null.
 *     push/disabled → NO directory fetch, NO `degraded`, sync columns untouched.
 *     response shape: { entries:[…], nextCursor, serverTime, degraded? }.
 *     gates: cross-account 403, unauth 401, unknown work 404.
 *
 * NOT DUPLICATED (surveyed flow-data-sync-platform.spec.ts,
 * flow-data-sync-dispatch-deep.spec.ts, data-sync-idempotency.spec.ts,
 * webhook-secret-rotation.spec.ts, rsc-payload-no-secrets.spec.ts):
 *   - flow-data-sync-platform → the WEBHOOK rotate-secret (POST /api/webhooks/:id/
 *     rotate-secret — a DIFFERENT surface) + the ingest 401/409/404 gates on a
 *     default pull-mode Work (never a SUCCESSFUL push ingest, never a mode flip).
 *   - data-sync* → the GIT data-sync force-sync endpoint /api/works/:id/sync,
 *     unrelated to the activity-feed transport mode.
 *   - webhook-secret-rotation → github-app/webhook rotate paths, NOT the
 *     per-Work /activity-sync/rotate-secret pull-transport rotation.
 *   NET-NEW HERE: the full pull→push→disabled→pull mode-SWITCH lifecycle, a
 *   SUCCESSFUL push ingest (202 {id}) + push idempotency, the pull-transport
 *   /activity-sync/rotate-secret 200/409/403/404 contract, the
 *   platformSyncLastError tracking written by a degraded pull-mode feed compose,
 *   and that flipping the mode flips both the ingest gate AND the feed transport.
 *
 * GOTCHAS honored: every mutation runs on a FRESH registerUserViaAPI() user
 * (never the shared seeded user); unique Date.now()-suffixed names; tolerant
 * matchers (toContain over exact counts) since the shared in-memory DB may carry
 * sibling rows; generous timeouts + expect.poll for the async best-effort
 * platformSync* column writes; the PLATFORM_API_SECRET_TOKEN is read from env
 * with the known e2e literal as a fallback so the canonical value stays out of
 * tracked source.
 */

// The platform-wide ingest bearer — pinned deterministically in the e2e API
// env (apps/api/.env). The PlatformSecretGuard compares against
// process.env.PLATFORM_API_SECRET_TOKEN with timingSafeEqual.
const PLATFORM_API_SECRET_TOKEN =
	process.env.PLATFORM_API_SECRET_TOKEN ?? 'e2e-platform-secret-token-deterministic-32+chars';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** Website action types accepted by the ingest endpoint (IngestEventDto). */
const WEBSITE_ACTION_TYPES = [
	'website_user_registered',
	'website_item_submitted',
	'website_report_filed',
	'website_report_resolved',
] as const;

function uuid(): string {
	return globalThis.crypto.randomUUID();
}

/** Build a minimally-valid ingest payload for a given Work. */
function ingestPayload(
	workId: string,
	overrides: Partial<{
		eventId: string;
		actionType: string;
		occurredAt: string;
		summary: string;
		metadata: Record<string, unknown>;
	}> = {},
) {
	return {
		workId,
		eventId: overrides.eventId ?? uuid(),
		actionType: overrides.actionType ?? 'website_user_registered',
		occurredAt: overrides.occurredAt ?? new Date().toISOString(),
		summary: overrides.summary ?? 'e2e activity-sync ingest event',
		...(overrides.metadata ? { metadata: overrides.metadata } : {}),
	};
}

/** Switch a Work's activitySyncMode via PATCH; returns the response. */
async function setMode(
	request: APIRequestContext,
	token: string,
	workId: string,
	mode: 'pull' | 'push' | 'disabled',
) {
	return request.patch(`${API_BASE}/api/works/${workId}`, {
		headers: authedHeaders(token),
		data: { activitySyncMode: mode },
	});
}

/** Read a Work and unwrap the `{ status, work }` envelope. */
async function getWork(request: APIRequestContext, token: string, workId: string) {
	const res = await request.get(`${API_BASE}/api/works/${workId}`, {
		headers: authedHeaders(token),
	});
	expect(res.status(), `get work body=${await res.text().catch(() => '')}`).toBe(200);
	const json = await res.json();
	return json.work ?? json;
}

/** POST an ingest event with the platform bearer. */
async function ingest(
	request: APIRequestContext,
	workId: string,
	overrides?: Parameters<typeof ingestPayload>[1],
	bearer: string = PLATFORM_API_SECRET_TOKEN,
) {
	return request.post(`${API_BASE}/api/activity-log/ingest`, {
		headers: { Authorization: `Bearer ${bearer}` },
		data: ingestPayload(workId, overrides),
	});
}

test.describe('Activity-sync — mode switch lifecycle (pull → push → disabled → pull)', () => {
	test('a Work defaults to pull and round-trips every mode through PATCH, recording work.updated rows', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `Sync Mode Lifecycle ${Date.now()}`,
		});
		expect(work.id).toBeTruthy();

		// A fresh Work is born in 'pull' mode with the observability columns
		// all null (no pull run has happened yet).
		const fresh = await getWork(request, owner.access_token, work.id);
		expect(fresh.activitySyncMode).toBe('pull');
		expect(fresh.platformSyncLastSuccessAt ?? null).toBeNull();
		expect(fresh.platformSyncLastErrorAt ?? null).toBeNull();
		expect(fresh.platformSyncLastErrorMessage ?? null).toBeNull();

		// Walk the full mode lattice. Each PATCH writes the column directly
		// (NOT git-gated) and returns the updated Work in the success envelope.
		for (const mode of ['push', 'disabled', 'pull'] as const) {
			const res = await setMode(request, owner.access_token, work.id, mode);
			expect(res.status(), `patch ${mode} body=${await res.text().catch(() => '')}`).toBe(
				200,
			);
			const body = await res.json();
			expect(body.status).toBe('success');
			// The returned Work reflects the new mode immediately.
			expect((body.work ?? body).activitySyncMode).toBe(mode);
			// And a fresh read confirms it persisted.
			const reread = await getWork(request, owner.access_token, work.id);
			expect(reread.activitySyncMode).toBe(mode);
		}

		// An invalid mode is rejected by class-validator's @IsIn before the
		// handler runs (the column is never corrupted).
		const bad = await request.patch(`${API_BASE}/api/works/${work.id}`, {
			headers: authedHeaders(owner.access_token),
			data: { activitySyncMode: 'bogus' },
		});
		expect(bad.status()).toBe(400);
		// The mode stayed at its last valid value ('pull').
		const afterBad = await getWork(request, owner.access_token, work.id);
		expect(afterBad.activitySyncMode).toBe('pull');

		// Each successful PATCH logged a `work.updated` activity row — the
		// observable trail of a settings change. (We did 3 successful PATCHes.)
		const listRes = await request.get(
			`${API_BASE}/api/activity-log?workId=${work.id}&actionType=work_updated`,
			{ headers: authedHeaders(owner.access_token) },
		);
		expect(listRes.ok()).toBeTruthy();
		const list = await listRes.json();
		const updatedRows = (list.activities ?? []).filter(
			(a: { action?: string }) => a.action === 'work.updated',
		);
		expect(updatedRows.length).toBeGreaterThanOrEqual(3);
	});

	test('mode switch is owner-scoped: a non-owner cannot flip another user’s sync mode', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const stranger = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `Sync Mode Guard ${Date.now()}`,
		});

		// Stranger PATCH → 403 with the stable ownership message (the work-scope
		// guard runs before the column write).
		const forbidden = await setMode(request, stranger.access_token, work.id, 'push');
		expect(forbidden.status()).toBe(403);
		const forbiddenBody = await forbidden.json();
		expect(forbiddenBody).toMatchObject({ status: 'error' });
		expect(forbiddenBody.message).toMatch(/do not have permission/i);

		// Unauthenticated PATCH → 401 (global JWT guard).
		const unauth = await request.patch(`${API_BASE}/api/works/${work.id}`, {
			data: { activitySyncMode: 'push' },
		});
		expect(unauth.status()).toBe(401);

		// The mode is still the pristine default for the owner.
		const owned = await getWork(request, owner.access_token, work.id);
		expect(owned.activitySyncMode).toBe('pull');
	});
});

test.describe('Activity-sync — push transport: ingest gate follows the mode', () => {
	test('flipping to push opens the ingest gate (202 {id}); flipping away re-closes it (409 mode-mismatch)', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `Push Ingest Gate ${Date.now()}`,
		});

		// While still in the default pull mode, ingest is rejected as a
		// mode-mismatch — the deployed site should be POSTing in push mode only.
		const pullReject = await ingest(request, work.id);
		expect(pullReject.status(), `pull body=${await pullReject.text().catch(() => '')}`).toBe(
			409,
		);
		expect(await pullReject.json()).toMatchObject({ error: 'mode-mismatch', mode: 'pull' });

		// Flip to push → the gate opens. A valid event is accepted (202) and
		// returns the created activity row id.
		expect((await setMode(request, owner.access_token, work.id, 'push')).status()).toBe(200);
		const accepted = await ingest(request, work.id, { summary: 'first push event' });
		expect(accepted.status(), `push body=${await accepted.text().catch(() => '')}`).toBe(202);
		const acceptedBody = await accepted.json();
		expect(typeof acceptedBody.id).toBe('string');
		expect(acceptedBody.id.length).toBeGreaterThan(0);

		// The ingested event surfaces in the owner's activity log as a
		// website_* row (ingest stamps the Work owner as the attributed user).
		await expect
			.poll(
				async () => {
					const r = await request.get(
						`${API_BASE}/api/activity-log?workId=${work.id}&actionType=website_user_registered`,
						{ headers: authedHeaders(owner.access_token) },
					);
					if (!r.ok()) return 0;
					return ((await r.json()).activities ?? []).length;
				},
				{ timeout: 15_000, message: 'push-ingested event should appear in the activity log' },
			)
			.toBeGreaterThanOrEqual(1);

		// Flip to disabled → the gate re-closes with a 409 naming the NEW mode.
		expect((await setMode(request, owner.access_token, work.id, 'disabled')).status()).toBe(
			200,
		);
		const disabledReject = await ingest(request, work.id);
		expect(disabledReject.status()).toBe(409);
		expect(await disabledReject.json()).toMatchObject({
			error: 'mode-mismatch',
			mode: 'disabled',
		});

		// Flip back to push → the gate opens again (the toggle is fully
		// reversible — no one-way latch).
		expect((await setMode(request, owner.access_token, work.id, 'push')).status()).toBe(200);
		const reaccepted = await ingest(request, work.id, { summary: 'event after re-enable' });
		expect(reaccepted.status()).toBe(202);
		expect(typeof (await reaccepted.json()).id).toBe('string');
	});

	test('push ingest is idempotent by (workId, eventId) and accepts every website action type', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `Push Ingest Idempotency ${Date.now()}`,
		});
		expect((await setMode(request, owner.access_token, work.id, 'push')).status()).toBe(200);

		// First ingest of a fixed eventId → 202 with a freshly-created id.
		const eventId = uuid();
		const first = await ingest(request, work.id, { eventId, summary: 'idempotent original' });
		expect(first.status()).toBe(202);
		const firstId = (await first.json()).id;
		expect(typeof firstId).toBe('string');

		// Replaying the SAME (workId, eventId) returns the SAME row id — the
		// retry-safe contract the deployed site relies on. The differing
		// summary is ignored (the original row is returned, not updated).
		const replay = await ingest(request, work.id, {
			eventId,
			summary: 'idempotent replay — should be ignored',
		});
		expect(replay.status()).toBe(202);
		expect((await replay.json()).id).toBe(firstId);

		// Every documented website action type is accepted (each with a fresh
		// eventId → a distinct row).
		for (const actionType of WEBSITE_ACTION_TYPES) {
			const res = await ingest(request, work.id, {
				actionType,
				summary: `event ${actionType}`,
				metadata: { actor: 'e2e tester', source: actionType },
			});
			expect(res.status(), `ingest ${actionType} body=${await res.text().catch(() => '')}`).toBe(
				202,
			);
			expect(typeof (await res.json()).id).toBe('string');
		}

		// An invalid action type is rejected by the DTO enum validator (400),
		// even in push mode with a valid bearer.
		const badAction = await ingest(request, work.id, { actionType: 'not_a_real_action' });
		expect(badAction.status()).toBe(400);
		const badActionBody = await badAction.json();
		const messages = Array.isArray(badActionBody.message)
			? badActionBody.message.join(' ')
			: String(badActionBody.message);
		expect(messages).toMatch(/actionType must be one of/i);
	});

	test('ingest bearer + payload validation runs independently of the mode gate', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `Push Ingest Validation ${Date.now()}`,
		});
		expect((await setMode(request, owner.access_token, work.id, 'push')).status()).toBe(200);

		// Missing bearer → 401 'Missing Bearer token' (PlatformSecretGuard,
		// before the mode/DTO checks).
		const noAuth = await request.post(`${API_BASE}/api/activity-log/ingest`, {
			data: ingestPayload(work.id),
		});
		expect(noAuth.status()).toBe(401);
		expect((await noAuth.json()).message).toMatch(/missing bearer token/i);

		// Wrong bearer → 401 'Invalid bearer token'.
		const wrongAuth = await ingest(request, work.id, undefined, 'definitely-not-the-token');
		expect(wrongAuth.status()).toBe(401);
		expect((await wrongAuth.json()).message).toMatch(/invalid bearer token/i);

		// Unknown work (well-formed uuid) → 404 'Work <id> not found' (checked
		// before the mode gate, so it surfaces even with the valid bearer).
		const unknownWork = await ingest(request, ZERO_UUID);
		expect(unknownWork.status()).toBe(404);
		expect((await unknownWork.json()).message).toMatch(/not found/i);

		// summary > 500 chars → 400 (MaxLength), even on a valid push Work.
		const longSummary = await ingest(request, work.id, { summary: 'x'.repeat(600) });
		expect(longSummary.status()).toBe(400);

		// metadata serialising over the 8 KiB cap → 400 (MetadataByteCap).
		const bigMetadata = await ingest(request, work.id, {
			metadata: { blob: 'y'.repeat(9000) },
		});
		expect(bigMetadata.status()).toBe(400);

		// A valid event still succeeds after all the rejected ones (the Work is
		// not left in a wedged state by failed validations).
		const ok = await ingest(request, work.id, { summary: 'valid after rejections' });
		expect(ok.status()).toBe(202);
	});
});

test.describe('Activity-sync — pull transport secret rotation', () => {
	test('rotate-secret is pull-mode-only: 200 in pull, 409 in push/disabled, and provisions the encrypted secret', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `Pull Rotate ${Date.now()}`,
		});

		// Before any rotation the per-Work pull secret is unprovisioned (null
		// ciphertext) — it is minted lazily on first rotate (or first deploy).
		const before = await getWork(request, owner.access_token, work.id);
		expect(before.platformSyncSecretEncrypted ?? null).toBeNull();

		// Pull-mode rotate (the default) → 200 with the redeploy-required flag.
		const rotate = await request.post(
			`${API_BASE}/api/works/${work.id}/activity-sync/rotate-secret`,
			{ headers: authedHeaders(owner.access_token) },
		);
		expect(rotate.status(), `rotate body=${await rotate.text().catch(() => '')}`).toBe(200);
		expect(await rotate.json()).toMatchObject({ status: 'success', redeployRequired: true });

		// The rotation provisioned the encrypted secret. It is an AES-256-GCM
		// ENVELOPE (ciphertext), never the raw HMAC key — assert it is present
		// and base64-shaped but DOES NOT look like a plaintext key/PEM.
		const after = await getWork(request, owner.access_token, work.id);
		expect(typeof after.platformSyncSecretEncrypted).toBe('string');
		expect(after.platformSyncSecretEncrypted.length).toBeGreaterThan(20);
		expect(after.platformSyncSecretEncrypted).toMatch(/^[A-Za-z0-9+/=]+$/);
		expect(after.platformSyncSecretEncrypted).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);

		// A second pull-mode rotation re-rolls the envelope to a DIFFERENT
		// ciphertext (the previous secret becomes irretrievable).
		const rotateAgain = await request.post(
			`${API_BASE}/api/works/${work.id}/activity-sync/rotate-secret`,
			{ headers: authedHeaders(owner.access_token) },
		);
		expect(rotateAgain.status()).toBe(200);
		const afterAgain = await getWork(request, owner.access_token, work.id);
		expect(afterAgain.platformSyncSecretEncrypted).not.toBe(after.platformSyncSecretEncrypted);

		// Flip to push → rotation is no longer applicable (the pull transport is
		// off). 409 names the current mode so the settings UI can explain why.
		expect((await setMode(request, owner.access_token, work.id, 'push')).status()).toBe(200);
		const pushRotate = await request.post(
			`${API_BASE}/api/works/${work.id}/activity-sync/rotate-secret`,
			{ headers: authedHeaders(owner.access_token) },
		);
		expect(pushRotate.status()).toBe(409);
		expect(await pushRotate.json()).toMatchObject({ error: 'mode-mismatch', mode: 'push' });

		// Same for disabled mode.
		expect((await setMode(request, owner.access_token, work.id, 'disabled')).status()).toBe(
			200,
		);
		const disabledRotate = await request.post(
			`${API_BASE}/api/works/${work.id}/activity-sync/rotate-secret`,
			{ headers: authedHeaders(owner.access_token) },
		);
		expect(disabledRotate.status()).toBe(409);
		expect(await disabledRotate.json()).toMatchObject({
			error: 'mode-mismatch',
			mode: 'disabled',
		});

		// A `work.activity_sync.secret_rotated` row was recorded for each of the
		// two successful (pull-mode) rotations.
		const listRes = await request.get(`${API_BASE}/api/activity-log?workId=${work.id}`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(listRes.ok()).toBeTruthy();
		const rotatedRows = ((await listRes.json()).activities ?? []).filter(
			(a: { action?: string }) => a.action === 'work.activity_sync.secret_rotated',
		);
		expect(rotatedRows.length).toBeGreaterThanOrEqual(2);
	});

	test('rotate-secret access gates: non-owner 403, unauth 401, unknown/non-uuid work 404', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const stranger = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `Pull Rotate Gates ${Date.now()}`,
		});
		const path = `${API_BASE}/api/works/${work.id}/activity-sync/rotate-secret`;

		// Non-owner → 403 (the work-scope ownership guard runs first).
		const forbidden = await request.post(path, { headers: authedHeaders(stranger.access_token) });
		expect(forbidden.status()).toBe(403);
		expect((await forbidden.json()).message).toMatch(/do not have permission/i);

		// Unauthenticated → 401 (global JWT guard).
		const unauth = await request.post(path);
		expect(unauth.status()).toBe(401);

		// Unknown (well-formed) work uuid → 404 with the stable not-found
		// envelope from the ownership service.
		const unknown = await request.post(
			`${API_BASE}/api/works/${ZERO_UUID}/activity-sync/rotate-secret`,
			{ headers: authedHeaders(owner.access_token) },
		);
		expect(unknown.status()).toBe(404);
		expect((await unknown.json()).message).toMatch(/not found/i);

		// Non-uuid work id → 404 (the ownership lookup fails to resolve it; the
		// route is NOT guarded by a ParseUUIDPipe here, so it surfaces as a
		// not-found, not a 400 validation error).
		const nonUuid = await request.post(
			`${API_BASE}/api/works/not-a-uuid/activity-sync/rotate-secret`,
			{ headers: authedHeaders(owner.access_token) },
		);
		expect(nonUuid.status()).toBe(404);
		expect((await nonUuid.json()).message).toMatch(/not found/i);
	});
});

test.describe('Activity-sync — pull-mode feed compose drives platformSyncLastError tracking', () => {
	test('a degraded pull compose records platformSyncLastErrorAt/Message; flipping away stops touching the columns', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `Pull Feed Observability ${Date.now()}`,
		});

		// Default pull mode: composing the activity feed runs the directory-site
		// pull transport. In CI the Work has no deployed website URL, so the pull
		// DEGRADES (rather than fetching real events).
		const feedRes = await request.get(`${API_BASE}/api/works/${work.id}/activity-feed`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(feedRes.status(), `feed body=${await feedRes.text().catch(() => '')}`).toBe(200);
		const feed = await feedRes.json();
		// Stable response envelope.
		expect(Array.isArray(feed.entries)).toBeTruthy();
		expect(typeof feed.serverTime).toBe('string');
		expect(feed).toHaveProperty('nextCursor');
		// The directory pull degraded with the truthful not-provisioned reason.
		expect(feed.degraded?.directorySite?.reason).toBe('not_provisioned');
		expect(feed.degraded?.directorySite?.detail).toMatch(/deployed website url/i);

		// recordSyncStatus is fired best-effort AFTER the response, so poll the
		// Work until the error-tracking columns land. A degraded pull writes
		// platformSyncLastErrorAt + a `<reason>: <detail>` message and leaves
		// platformSyncLastSuccessAt null.
		const errored = await expect
			.poll(
				async () => {
					const w = await getWork(request, owner.access_token, work.id);
					return w.platformSyncLastErrorAt ?? null;
				},
				{
					timeout: 20_000,
					message:
						'a degraded pull-mode feed compose should write platformSyncLastErrorAt',
				},
			)
			.not.toBeNull();
		void errored;

		const afterPull = await getWork(request, owner.access_token, work.id);
		expect(afterPull.platformSyncLastErrorAt).toBeTruthy();
		expect(afterPull.platformSyncLastErrorMessage).toMatch(/not_provisioned/i);
		// A degraded run never claims success.
		expect(afterPull.platformSyncLastSuccessAt ?? null).toBeNull();
		const errorStampedAt = afterPull.platformSyncLastErrorAt;

		// Flip to push: the directory pull is NOT run, so the feed has no
		// `degraded` block and the sync-status columns are left untouched.
		expect((await setMode(request, owner.access_token, work.id, 'push')).status()).toBe(200);
		const pushFeedRes = await request.get(`${API_BASE}/api/works/${work.id}/activity-feed`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(pushFeedRes.status()).toBe(200);
		const pushFeed = await pushFeedRes.json();
		expect(pushFeed.degraded ?? null).toBeNull();

		// Give any (non-existent) async write a beat, then confirm the error
		// timestamp did NOT advance — push mode does not touch the pull columns.
		await expect
			.poll(
				async () => {
					const w = await getWork(request, owner.access_token, work.id);
					return w.platformSyncLastErrorAt;
				},
				{ timeout: 5_000, intervals: [500, 1000, 1500] },
			)
			.toBe(errorStampedAt);
	});

	test('activity-feed access gates: cross-account 403, unauth 401, unknown work 404', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const stranger = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `Feed Gates ${Date.now()}`,
		});
		const path = `${API_BASE}/api/works/${work.id}/activity-feed`;

		// Non-owner → 403 with the ownership message.
		const forbidden = await request.get(path, { headers: authedHeaders(stranger.access_token) });
		expect(forbidden.status()).toBe(403);
		expect((await forbidden.json()).message).toMatch(/do not have permission/i);

		// Unauthenticated → 401.
		const unauth = await request.get(path);
		expect(unauth.status()).toBe(401);

		// Unknown work → 404 with the stable not-found envelope.
		const unknown = await request.get(`${API_BASE}/api/works/${ZERO_UUID}/activity-feed`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(unknown.status()).toBe(404);
		expect((await unknown.json()).message).toMatch(/not found/i);
	});
});
