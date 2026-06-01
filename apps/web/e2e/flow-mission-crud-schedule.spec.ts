import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Mission CRUD + schedule/cadence + autoBuildWorks + status state-machine +
 * validation — deep, multi-step END-TO-END integration flows for the real
 * Missions surface (`apps/api/src/missions/missions.controller.ts` +
 * `dto/mission.dto.ts`, backed by `@ever-works/agent/missions`
 * MissionsService + MissionTickService + cron-matcher).
 *
 * Every shape / status / error message below was PROBED against the LIVE API
 * at http://127.0.0.1:3100 before assertions were written. Probed contract:
 *
 *   POST /api/me/missions  (CreateMissionDto, whitelisted ValidationPipe)
 *     - title?         IsString MinLength(1) MaxLength(200)  → "title must be shorter than or equal to 200 characters"
 *                      (when omitted the heuristic TitlerService derives it from `description`;
 *                       on this stack the derived title == the (short) description verbatim)
 *     - description    IsString MinLength(1) MaxLength(10000) → required + bounds
 *     - type           IsEnum(MissionType) one-shot|scheduled → "type must be one of the following values: one-shot, scheduled"
 *     - schedule?      IsString MaxLength(64), nullable       → cron string stored VERBATIM (NO cron-syntax validation at create/PATCH)
 *     - autoBuildWorks?IsBoolean (default false)
 *     - outstandingIdeasCap? IsInt Min(-1)                    → "outstandingIdeasCap must not be less than -1"
 *                            (null = inherit user default, -1 = unlimited, n = that cap)
 *     - unknown prop   → 400 "property <x> should not exist"
 *   Service-side schedule↔type consistency (assertScheduleConsistency, reused by PATCH):
 *     - type=scheduled + no schedule → 400 "Mission.type=scheduled requires a non-empty `schedule` (cron expression)."
 *     - type=one-shot  + schedule    → 400 "Mission.type=one-shot must NOT have a `schedule` set; pass null or omit."
 *   Created Mission defaults: status='active', autoBuildWorks=false, schedule=null (one-shot),
 *     outstandingIdeasCap=null, sourceMissionId=null, missionRepo=null.
 *   Lifecycle state-machine (POST :id/{pause,resume,complete}):
 *     pause:    active→paused          (else 400 "Mission cannot be paused from status \"<s>\". Allowed: active.")
 *     resume:   paused→active          (else 400 "... resumed ... Allowed: paused.")
 *     complete: active|paused→completed(else 400 "... completed ... Allowed: active, paused.")
 *     delete:   from ANY status → 200 { deleted: true }
 *   Run-now (POST :id/run-now, cron-BYPASS — allowCronMismatch=true): on this CI/local stack
 *     (no LLM provider / no research profile) the truthful response is
 *     { status:'no-ideas', missionId, message:'skipped-no-profile' } for BOTH one-shot AND
 *     scheduled Missions whose cron can never match "now" — proving run-now bypasses the cron.
 *     Gated to ACTIVE|PAUSED → 400 from COMPLETED ("Mission cannot be run from status \"completed\". Allowed: active, paused.").
 *
 * DEVIATION (documented): there is NO `nextRun` field on the Mission entity and NO
 * next-run computation endpoint. "schedule→nextRun" lives only inside the tick worker's
 * `matchesCron(schedule, now)` (UTC, 5-field, no @aliases/L/W/#). The closest REAL,
 * deterministically-assertable behaviour is (a) the cron string is persisted verbatim and
 * (b) run-now's cron-bypass returns a non-`cron-no-match` outcome regardless of whether the
 * stored cron could ever fire. Flow 5 pins exactly that rather than a fictional nextRun.
 *
 * NON-DUPLICATION: the schedule-consistency PATCH round-trip lives in
 * flow-mission-clone.spec.ts (flow 2); the basic CRUD happy-path + linear
 * pause→resume→complete lives in missions.spec.ts; run-now shape/cap/ownership
 * lives in flow-mission-idea-build.spec.ts (flow 3). These flows deliberately cover
 * the UNCOVERED angles: the full CREATE-time validation matrix, the autoBuildWorks +
 * cap-sentinel toggle lifecycle, the cron cadence storage-fidelity matrix (incl.
 * aliases/ranges/steps/invalid-cron), the EXHAUSTIVE illegal-transition guard matrix
 * from every status, the run-now cron-BYPASS equivalence, and a UI card render of the
 * cadence/cap/auto-build chips.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface MissionDto {
	id: string;
	title: string;
	description: string;
	type: 'one-shot' | 'scheduled';
	status: 'active' | 'paused' | 'completed' | 'failed';
	schedule: string | null;
	autoBuildWorks: boolean;
	outstandingIdeasCap: number | null;
	guardrailsOverride: Record<string, unknown> | null;
	missionTemplateRepo: string | null;
	missionRepo: string | null;
	sourceMissionId: string | null;
	createdAt: string;
	updatedAt: string;
}

function stamp(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function seededToken(request: APIRequestContext): Promise<string> {
	// LOGIN DTO is whitelisted — pass ONLY {email,password}.
	const seeded = loadSeededTestUser();
	const res = await request.post(`${API_BASE}/api/auth/login`, {
		data: { email: seeded.email, password: seeded.password }
	});
	expect(res.status(), `seeded login body=${await res.text()}`).toBe(200);
	return (await res.json()).access_token as string;
}

async function createMission(
	request: APIRequestContext,
	token: string,
	data: Record<string, unknown>
): Promise<MissionDto> {
	const res = await request.post(`${API_BASE}/api/me/missions`, {
		headers: authedHeaders(token),
		data
	});
	expect(res.status(), `mission create body=${await res.text()}`).toBe(201);
	return res.json();
}

async function getMission(
	request: APIRequestContext,
	token: string,
	id: string
): Promise<MissionDto> {
	const res = await request.get(`${API_BASE}/api/me/missions/${id}`, {
		headers: authedHeaders(token)
	});
	expect(res.status()).toBe(200);
	return res.json();
}

test.describe('Mission CRUD + schedule/cadence + status', () => {
	/**
	 * Flow 1 — CREATE-time validation matrix. The DTO ValidationPipe + the
	 * service-side schedule-consistency check reject every malformed body with a
	 * 400 (never a 5xx, never a silent accept), while well-formed bodies persist
	 * the exact defaults. Pins the precise i18n-free error messages so a future
	 * loosening of a bound is caught.
	 */
	test('create validation: bounds, enum, whitelist, and schedule↔type consistency all 400 truthfully', async ({
		request
	}) => {
		const owner = await registerUserViaAPI(request);
		const token = owner.access_token;
		const headers = authedHeaders(token);
		const sfx = stamp();

		// A bag of bad bodies → each must 400 with the probed message fragment.
		const longTitle = 'T'.repeat(201);
		const longDesc = 'D'.repeat(10001);
		const longCron = '*/2 '.repeat(20); // > 64 chars
		const badBodies: Array<{ name: string; body: Record<string, unknown>; match: RegExp }> = [
			{ name: 'title>200', body: { title: longTitle, description: 'x', type: 'one-shot' }, match: /title must be shorter than or equal to 200 characters/i },
			{ name: 'description missing', body: { type: 'one-shot' }, match: /description must be a string|description must be longer than or equal to 1 characters/i },
			{ name: 'description empty', body: { description: '', type: 'one-shot' }, match: /description must be longer than or equal to 1 characters/i },
			{ name: 'description>10000', body: { description: longDesc, type: 'one-shot' }, match: /description must be shorter than or equal to 10000 characters/i },
			{ name: 'type bad enum', body: { description: 'x', type: 'recurring' }, match: /type must be one of the following values: one-shot, scheduled/i },
			{ name: 'schedule>64', body: { description: 'x', type: 'scheduled', schedule: longCron }, match: /schedule must be shorter than or equal to 64 characters/i },
			{ name: 'cap < -1', body: { description: 'x', type: 'one-shot', outstandingIdeasCap: -2 }, match: /outstandingIdeasCap must not be less than -1/i },
			{ name: 'unknown property', body: { description: 'x', type: 'one-shot', bogus: true }, match: /property bogus should not exist/i },
			{ name: 'scheduled without cron', body: { description: 'x', type: 'scheduled' }, match: /scheduled requires a non-empty `schedule`/i },
			{ name: 'one-shot WITH cron', body: { description: 'x', type: 'one-shot', schedule: '0 9 * * 1' }, match: /one-shot must NOT have a `schedule`/i }
		];

		for (const tc of badBodies) {
			const res = await request.post(`${API_BASE}/api/me/missions`, { headers, data: tc.body });
			expect(res.status(), `${tc.name} → expected 400, body=${await res.text()}`).toBe(400);
			const body = await res.json();
			const msg = Array.isArray(body.message) ? body.message.join(' | ') : body.message;
			expect(msg, `${tc.name} message`).toMatch(tc.match);
		}

		// A well-formed one-shot persists the documented defaults verbatim.
		const ok = await createMission(request, token, {
			title: `Valid Mission ${sfx}`,
			description: `valid mission body ${sfx}`,
			type: 'one-shot'
		});
		expect(ok.id).toMatch(UUID_RE);
		expect(ok.status).toBe('active');
		expect(ok.type).toBe('one-shot');
		expect(ok.schedule).toBeNull();
		expect(ok.autoBuildWorks).toBe(false);
		expect(ok.outstandingIdeasCap).toBeNull();
		expect(ok.guardrailsOverride).toBeNull();
		expect(ok.sourceMissionId).toBeNull();
		expect(ok.missionRepo).toBeNull();

		// All the rejected creates left NO rows behind — the list holds only the one valid Mission.
		const list = await request.get(`${API_BASE}/api/me/missions`, { headers });
		expect(list.status()).toBe(200);
		const all: MissionDto[] = await list.json();
		expect(all.map((m) => m.id)).toContain(ok.id);
		// Every Mission in the fresh user's list is the valid one (no malformed rows persisted).
		for (const m of all) {
			expect(m.id).toBe(ok.id);
		}
	});

	/**
	 * Flow 2 — autoBuildWorks + outstandingIdeasCap toggle lifecycle. Create with
	 * explicit non-defaults, then PATCH the toggle/cap through every meaningful
	 * value (false↔true; cap positive → -1 unlimited → null inherit) and assert each
	 * change PERSISTS via a fresh GET. Pins the three cap sentinels independently.
	 */
	test('autoBuildWorks + cap sentinels: every toggle persists across a fresh GET', async ({
		request
	}) => {
		const owner = await registerUserViaAPI(request);
		const token = owner.access_token;
		const headers = authedHeaders(token);
		const sfx = stamp();

		// Born with autoBuildWorks=true + a positive cap.
		const mission = await createMission(request, token, {
			title: `Toggle Mission ${sfx}`,
			description: `auto-build + cap toggle ${sfx}`,
			type: 'one-shot',
			autoBuildWorks: true,
			outstandingIdeasCap: 5
		});
		expect(mission.autoBuildWorks).toBe(true);
		expect(mission.outstandingIdeasCap).toBe(5);

		async function patch(data: Record<string, unknown>): Promise<MissionDto> {
			const res = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
				headers,
				data
			});
			expect(res.status(), `patch ${JSON.stringify(data)} body=${await res.text()}`).toBe(200);
			return res.json();
		}

		// autoBuildWorks true → false, persists.
		expect((await patch({ autoBuildWorks: false })).autoBuildWorks).toBe(false);
		expect((await getMission(request, token, mission.id)).autoBuildWorks).toBe(false);

		// autoBuildWorks false → true, persists.
		expect((await patch({ autoBuildWorks: true })).autoBuildWorks).toBe(true);
		expect((await getMission(request, token, mission.id)).autoBuildWorks).toBe(true);

		// cap positive → -1 "unlimited" sentinel, persists exactly (NOT normalized to null).
		expect((await patch({ outstandingIdeasCap: -1 })).outstandingIdeasCap).toBe(-1);
		expect((await getMission(request, token, mission.id)).outstandingIdeasCap).toBe(-1);

		// cap -1 → null "inherit user default", persists.
		expect((await patch({ outstandingIdeasCap: null })).outstandingIdeasCap).toBeNull();
		expect((await getMission(request, token, mission.id)).outstandingIdeasCap).toBeNull();

		// cap null → a fresh positive number, persists.
		const finalState = await patch({ outstandingIdeasCap: 12, autoBuildWorks: false });
		expect(finalState.outstandingIdeasCap).toBe(12);
		expect(finalState.autoBuildWorks).toBe(false);
		const persisted = await getMission(request, token, mission.id);
		expect(persisted.outstandingIdeasCap).toBe(12);
		expect(persisted.autoBuildWorks).toBe(false);
		// updatedAt advanced past createdAt after the mutation sequence.
		expect(new Date(persisted.updatedAt).getTime()).toBeGreaterThanOrEqual(
			new Date(persisted.createdAt).getTime()
		);

		// A cap below the -1 floor is still rejected on PATCH (same DTO bound as create).
		const badCap = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
			headers,
			data: { outstandingIdeasCap: -5 }
		});
		expect(badCap.status()).toBe(400);
		expect((await badCap.json()).message.join(' ')).toMatch(/must not be less than -1/i);
	});

	/**
	 * Flow 3 — cron cadence storage-fidelity matrix. The platform stores the
	 * cron string VERBATIM (no syntax validation at the DTO/service layer beyond
	 * MaxLength 64) — so a wide spread of valid forms (literal, range, step,
	 * enumeration, 3-letter aliases) AND a deliberately-malformed cron all round-trip
	 * byte-for-byte through create + GET. This pins the "schedule is opaque to the
	 * write path; only the tick worker interprets it" contract.
	 */
	test('cron cadence: many distinct schedules round-trip verbatim (incl. aliases + invalid)', async ({
		request
	}) => {
		const owner = await registerUserViaAPI(request);
		const token = owner.access_token;
		const headers = authedHeaders(token);
		const sfx = stamp();

		const cadences = [
			'0 9 * * 1', // every Monday 09:00
			'*/15 * * * *', // every 15 minutes
			'0 0 1 * *', // 1st of month midnight
			'30 8-17 * * 1-5', // weekday business hours, half past
			'0 6 * JAN,JUL MON', // 3-letter month + dow aliases
			'15 */3 1-7 * SUN', // step hours + dom range + dow alias
			'not a valid cron at all' // deliberately invalid — stored verbatim, never rejected
		];

		const created: Array<{ schedule: string; id: string }> = [];
		for (const cron of cadences) {
			const m = await createMission(request, token, {
				title: `Cadence ${sfx} :: ${cron.slice(0, 20)}`,
				description: `cadence probe ${sfx}`,
				type: 'scheduled',
				schedule: cron
			});
			expect(m.type).toBe('scheduled');
			// Stored byte-for-byte (no normalization, no rejection).
			expect(m.schedule).toBe(cron);
			created.push({ schedule: cron, id: m.id });
		}

		// Each one re-reads verbatim from a fresh GET.
		for (const c of created) {
			const fresh = await getMission(request, token, c.id);
			expect(fresh.schedule).toBe(c.schedule);
			expect(fresh.type).toBe('scheduled');
		}

		// PATCHing the cadence to a new cron on an already-scheduled Mission keeps it
		// scheduled and swaps the cron verbatim.
		const target = created[0];
		const newCron = '45 23 * * 0'; // Sunday 23:45
		const patched = await request.patch(`${API_BASE}/api/me/missions/${target.id}`, {
			headers,
			data: { schedule: newCron }
		});
		expect(patched.status()).toBe(200);
		const patchedBody: MissionDto = await patched.json();
		expect(patchedBody.type).toBe('scheduled');
		expect(patchedBody.schedule).toBe(newCron);
		expect((await getMission(request, token, target.id)).schedule).toBe(newCron);
	});

	/**
	 * Flow 4 — EXHAUSTIVE status state-machine guard matrix. From each reachable
	 * status (active / paused / completed) every ILLEGAL transition returns 400 with
	 * the exact verb-specific message + the allowed-from list, while the LEGAL ones
	 * succeed. Also proves delete is allowed from ANY status. This is the full guard
	 * grid, distinct from missions.spec.ts's single linear walk.
	 */
	test('status state-machine: illegal transitions 400 with exact messages from every status', async ({
		request
	}) => {
		const owner = await registerUserViaAPI(request);
		const token = owner.access_token;
		const headers = authedHeaders(token);
		const sfx = stamp();

		async function fresh(): Promise<MissionDto> {
			return createMission(request, token, {
				title: `SM ${sfx} ${Math.random().toString(36).slice(2, 6)}`,
				description: `state-machine probe ${sfx}`,
				type: 'one-shot'
			});
		}
		async function act(id: string, verb: 'pause' | 'resume' | 'complete') {
			return request.post(`${API_BASE}/api/me/missions/${id}/${verb}`, { headers, data: {} });
		}

		// ── From ACTIVE: resume is illegal; pause + complete are legal. ──────────
		const a = await fresh();
		expect(a.status).toBe('active');
		const resumeActive = await act(a.id, 'resume');
		expect(resumeActive.status()).toBe(400);
		expect((await resumeActive.json()).message).toMatch(
			/cannot be resumed from status "active"\. Allowed: paused/i
		);

		// ── ACTIVE → PAUSED (legal). From PAUSED: pause is illegal; resume/complete legal. ──
		const pauseRes = await act(a.id, 'pause');
		expect(pauseRes.status()).toBe(200);
		expect((await pauseRes.json()).status).toBe('paused');

		const pausePaused = await act(a.id, 'pause');
		expect(pausePaused.status()).toBe(400);
		expect((await pausePaused.json()).message).toMatch(
			/cannot be paused from status "paused"\. Allowed: active/i
		);

		// PAUSED → ACTIVE (resume legal), then back to a clean active state.
		const resumeRes = await act(a.id, 'resume');
		expect(resumeRes.status()).toBe(200);
		expect((await resumeRes.json()).status).toBe('active');

		// ── Drive a fresh Mission to COMPLETED; from COMPLETED everything is illegal. ──
		const c = await fresh();
		const completeRes = await act(c.id, 'complete');
		expect(completeRes.status()).toBe(200);
		expect((await completeRes.json()).status).toBe('completed');

		for (const verb of ['pause', 'resume', 'complete'] as const) {
			const res = await act(c.id, verb);
			expect(res.status(), `${verb} from completed`).toBe(400);
			const re = new RegExp(`cannot be ${verb}d from status "completed"`, 'i');
			expect((await res.json()).message).toMatch(re);
		}

		// ── delete is allowed from ANY status (here: COMPLETED). ─────────────────
		const delCompleted = await request.delete(`${API_BASE}/api/me/missions/${c.id}`, { headers });
		expect(delCompleted.status()).toBe(200);
		expect((await delCompleted.json())).toEqual({ deleted: true });
		// And from PAUSED.
		const delPaused = await request.delete(`${API_BASE}/api/me/missions/${a.id}`, { headers });
		expect(delPaused.status()).toBe(200);
		// Both gone now.
		expect((await request.get(`${API_BASE}/api/me/missions/${c.id}`, { headers })).status()).toBe(404);
		expect((await request.get(`${API_BASE}/api/me/missions/${a.id}`, { headers })).status()).toBe(404);
	});

	/**
	 * Flow 5 — run-now is a cron-BYPASS for BOTH mission types ("schedule→nextRun"
	 * is not a computed field; the closest real behaviour is that a manual run-now
	 * fires regardless of whether the stored cron could ever match "now"). A one-shot
	 * (no cron) and a scheduled Mission whose cron is the far-future `0 0 1 1 *`
	 * (Jan 1st only) BOTH return a non-`cron-no-match` outcome — on this CI/local
	 * stack the truthful outcome is `no-ideas` + `skipped-no-profile` (no LLM/profile),
	 * but we tolerate the full real outcome enum. run-now from COMPLETED is gated 400.
	 */
	test('run-now bypasses cron for one-shot AND scheduled; gated by status', async ({ request }) => {
		const owner = await registerUserViaAPI(request);
		const token = owner.access_token;
		const headers = authedHeaders(token);
		const sfx = stamp();

		// Outcomes that prove run-now did NOT short-circuit on the cron match check.
		// (cron-no-match would mean the bypass failed; noop-placeholder means the tick
		//  service wasn't wired — acceptable but we don't expect it in this stack.)
		const NON_CRON_OUTCOMES = ['no-ideas', 'spawned', 'cap-hit', 'failed', 'queued', 'noop-placeholder'];

		async function runNow(id: string) {
			const res = await request.post(`${API_BASE}/api/me/missions/${id}/run-now`, {
				headers,
				data: {}
			});
			return res;
		}

		// ── one-shot (no cron at all) → run-now still runs. ──────────────────────
		const oneShot = await createMission(request, token, {
			title: `RunNow one-shot ${sfx}`,
			description: `run-now one-shot ${sfx}`,
			type: 'one-shot'
		});
		const r1 = await runNow(oneShot.id);
		expect(r1.status(), `one-shot run-now body=${await r1.text()}`).toBe(200);
		const b1 = await r1.json();
		expect(b1.missionId).toBe(oneShot.id);
		expect(b1.status).not.toBe('cron-no-match');
		expect(NON_CRON_OUTCOMES).toContain(b1.status);

		// ── scheduled with a cron that can essentially never match "now"
		//    (Jan 1st 00:00). The cron MATCH check would skip it on the dispatcher,
		//    but run-now's allowCronMismatch=true bypasses that → it still runs. ──
		const scheduled = await createMission(request, token, {
			title: `RunNow scheduled ${sfx}`,
			description: `run-now scheduled ${sfx}`,
			type: 'scheduled',
			schedule: '0 0 1 1 *'
		});
		const r2 = await runNow(scheduled.id);
		expect(r2.status(), `scheduled run-now body=${await r2.text()}`).toBe(200);
		const b2 = await r2.json();
		expect(b2.missionId).toBe(scheduled.id);
		expect(b2.status).not.toBe('cron-no-match');
		expect(NON_CRON_OUTCOMES).toContain(b2.status);
		// Both mission types yield the SAME outcome family on this profile-less stack,
		// proving the cron value is irrelevant to run-now.
		expect(b2.status).toBe(b1.status);

		// ── run-now is still allowed from PAUSED (a paused user click is legit). ──
		const pause = await request.post(`${API_BASE}/api/me/missions/${scheduled.id}/pause`, {
			headers,
			data: {}
		});
		expect(pause.status()).toBe(200);
		const r3 = await runNow(scheduled.id);
		expect(r3.status()).toBe(200);
		expect((await r3.json()).status).not.toBe('cron-no-match');

		// ── run-now is FORBIDDEN from COMPLETED (state gate fires before dispatch). ──
		await request.post(`${API_BASE}/api/me/missions/${scheduled.id}/resume`, { headers, data: {} });
		await request.post(`${API_BASE}/api/me/missions/${scheduled.id}/complete`, { headers, data: {} });
		const r4 = await runNow(scheduled.id);
		expect(r4.status()).toBe(400);
		expect((await r4.json()).message).toMatch(
			/cannot be run from status "completed"\. Allowed: active, paused/i
		);
	});

	/**
	 * Flow 6 — UI: a one-shot + a scheduled Mission created via API surface on
	 * /missions with their cadence/cap/auto-build chips rendered correctly. Asserts
	 * the REAL MissionCard render (apps/web/src/components/missions/MissionCard.tsx):
	 * "One-shot" vs "Scheduled" chip, the verbatim cron `<code>`, the "Auto-build
	 * on/off" line, and the cap label ("Unlimited" for -1). Driven by the seeded user
	 * (storageState). Distinct from missions-ideas-hierarchy.spec.ts, which only asserts
	 * the title appears — here we pin the schedule/auto-build/cap surface.
	 */
	test('UI: mission cards render cadence, auto-build, and cap chips on /missions', async ({
		page,
		request
	}, testInfo) => {
		const token = await seededToken(request);
		const sfx = stamp();

		// A scheduled, auto-build-on, unlimited-cap Mission.
		const schedTitle = `UI Scheduled ${sfx}`;
		const cron = '0 9 * * 1';
		const scheduled = await createMission(request, token, {
			title: schedTitle,
			description: `ui scheduled card ${sfx}`,
			type: 'scheduled',
			schedule: cron,
			autoBuildWorks: true,
			outstandingIdeasCap: -1
		});
		expect(scheduled.id).toMatch(UUID_RE);

		// A one-shot, auto-build-off, inherit-cap Mission.
		const oneShotTitle = `UI OneShot ${sfx}`;
		const oneShot = await createMission(request, token, {
			title: oneShotTitle,
			description: `ui one-shot card ${sfx}`,
			type: 'one-shot'
		});
		expect(oneShot.id).toMatch(UUID_RE);

		await page.goto('/missions', { waitUntil: 'domcontentloaded' });

		// The scheduled card: title visible, "Scheduled" chip, verbatim cron, "Auto-build on", "Unlimited" cap.
		const schedHeading = page.getByRole('heading', { name: schedTitle }).first();
		await expect(schedHeading).toBeVisible({ timeout: 30_000 });
		// The whole card is a <Link> to /missions/:id — scope chip assertions to it.
		const schedCard = page.locator(`a[href$="/missions/${scheduled.id}"]`).first();
		await expect(schedCard).toBeVisible({ timeout: 30_000 });
		await expect(schedCard.getByText('Scheduled', { exact: true })).toBeVisible();
		await expect(schedCard.getByText(cron, { exact: true })).toBeVisible();
		await expect(schedCard.getByText('Auto-build on', { exact: true })).toBeVisible();
		await expect(schedCard.getByText('Unlimited', { exact: true })).toBeVisible();

		// The one-shot card: "One-shot" chip, NO cron line, "Auto-build off", inherit cap.
		const oneShotCard = page.locator(`a[href$="/missions/${oneShot.id}"]`).first();
		await expect(oneShotCard).toBeVisible({ timeout: 30_000 });
		await expect(oneShotCard.getByText('One-shot', { exact: true })).toBeVisible();
		await expect(oneShotCard.getByText('Auto-build off', { exact: true })).toBeVisible();
		await expect(oneShotCard.getByText('Inherit user default', { exact: true })).toBeVisible();
		// A one-shot has no schedule → no "Cron:" prefix inside its card.
		await expect(oneShotCard.getByText('Cron:', { exact: false })).toHaveCount(0);

		testInfo.annotations.push({
			type: 'note',
			description:
				'MissionCard chip text is i18n dashboard.missionsPage.card.* — asserted against en.json verbatim.'
		});
	});
});
