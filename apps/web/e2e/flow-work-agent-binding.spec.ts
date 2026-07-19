import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-work-agent-binding — the USER-LEVEL "Work agent" controller
 * (`@Controller('api/me/work-agent')`,
 * `apps/api/src/work-agent/work-agent.controller.ts` →
 * `@ever-works/agent/work-agent` `WorkAgentService`). This is the singleton
 * autonomous Work-builder bound to the CURRENT USER (preferences/guardrails +
 * queued BUILD REQUESTS (formerly "goals", renamed per review §23.3) that each
 * spawn a RUN + run LOGS), NOT the per-work Agent row.
 *
 * Every status code, message, and JSON shape asserted below was PROBED against
 * the LIVE keyless sqlite-in-memory CI driver at http://127.0.0.1:3100 BEFORE a
 * single assertion was written (2026-06-12, curl + cross-read of the controller
 * + WorkAgentService + work-agent.dto.ts).
 *
 * NON-DUPLICATION — this file pins the `api/me/work-agent` (singleton user
 * Work-agent) contract and deliberately stays clear of:
 *   - `flow-settings-work-agent.spec.ts` — owns the DIFFERENT "agent bound to a
 *     work" surface: `POST/PATCH/GET /api/agents` with `scope:'work', workId`
 *     (the per-work Agent ROW + its AI-provider/permissions config, the
 *     generator-form provider list, and per-work advanced-prompts). It never
 *     touches `/api/me/work-agent/*`.
 *   - `flow-mission-guardrails.spec.ts` / `flow-mission-budget-contract.spec.ts`
 *     — the per-Mission guardrail + budget surfaces under `/api/me/missions/*`.
 *   - `flow-agent-budget-enforcement` / `flow-budget-agent-spend` — the
 *     `accountWideMonthlyCapCents` over-budget HARD STOP and `/api/agents/:id/
 *     budget`. We touch the prefs DTO's account-wide knob only as VALIDATION
 *     boundaries (string regex / overage flag round-trip), never the spend gate.
 *
 *   This file pins the contracts none of those cover:
 *     1. GET /preferences — the well-formed ZERO/DEFAULT state of a brand-new
 *        user's Work agent: enabled=false, dailySuggestionsEnabled=true, the
 *        nested `guardrails` block with its 7 hardcoded defaults
 *        (maxWorksPerRun 1 / maxItemsPerWork 50 / dryRunByDefault true / …),
 *        and the 9 promoted top-level knobs (autoGenerateCadence null,
 *        maxAutoRetries 2, backoffSeconds 60, exponentialBackoffFactor 2,
 *        accountWideAllowOverage true, …).
 *     2. PUT /preferences — partial-merge persistence (enabled flips, a guardrail
 *        sub-key merges into the nested block without resetting its siblings, a
 *        promoted knob round-trips) + the GUARDRAIL-OVERRIDE CLAMP behavior is
 *        validated at the DTO edge (a guardrail value above its Max is a 400,
 *        NOT a silent clamp on this endpoint).
 *     3. PUT /preferences VALIDATION boundaries (all 400, class-validator):
 *        cron cadence must match the supported star-slash-N minute form;
 *        maxAutoRetries Max 5; guardrail
 *        maxWorksPerRun Max 25; accountWideMonthlyCapCents must be a digit
 *        string; an unknown body key is rejected (forbidNonWhitelisted).
 *     4. POST /build-requests GATE: a build request is REJECTED 400 "Work agent is
 *        disabled." until the user's preference `enabled` is true — the enable-gate
 *        that fronts the whole build-request pipeline.
 *     5. POST /build-requests DTO validation: instruction MinLength 10 / required /
 *        unknown-key rejected — and `ideaId` (present on the service interface
 *        but NOT whitelisted on CreateWorkBuildRequestDto) is REJECTED, a real
 *        contract gap worth pinning.
 *     6. POST /build-requests SUCCESS contract (enabled): a build request + its run
 *        are created in one transaction — status='waiting-for-approval', source='user',
 *        dryRun defaults to the pref guardrail's dryRunByDefault (true), the run
 *        mirrors buildRequestId + status + progressPercent 10 + a summary rollup; the
 *        build request then appears in GET /build-requests (DESC) and the run becomes the
 *        GET /runs/active row, with two seeded INFO logs on GET /runs/:id/logs.
 *     7. Build-request guardrail-OVERRIDE: passing guardrail sub-keys on the body
 *        records them as `guardrailsOverride` on the build request (only the supplied
 *        keys), and `dryRun:false` flips the plan/approval summary to the live
 *        copy — without mutating the user's stored preference guardrails.
 *     8. CANCEL lifecycle: PATCH /build-requests/:id/cancel flips it to 'canceled'
 *        AND cancels its active run (runs/active goes empty); a SECOND cancel is
 *        a 400 "can no longer be canceled." terminal-state guard.
 *     9. OWNERSHIP SCOPING + id validation: a foreign user's build-request-cancel / run-
 *        logs read is an opaque 404 (no existence leak), an unknown well-formed
 *        uuid is 404, a malformed id is a 400 ParseUUIDPipe failure, and the
 *        build-requests list is per-user isolated. anon (empty storageState) → 401 on
 *        every verb.
 *    13. DEPRECATED /goals ALIAS (review §23.3): the old /goals + /goals/:id/cancel
 *        routes stay as thin aliases of /build-requests for one release window —
 *        pinned so removing them is a conscious contract change.
 *
 * GOTCHAS honored: FRESH registerUserViaAPI() user per test (full isolation,
 * never the shared seeded user); unique suffix from a per-test counter (NOT a
 * module-scope clock); NO module-scope await / loadSeededTestUser; anon uses an
 * EXPLICIT empty storageState so it cannot inherit the shared auth cookie;
 * keyless/no-LLM/no-Trigger CI ⇒ we assert the build-request/run RECORD contracts (the
 * approval-gated plan), NEVER a generation/run COMPLETION; generous timeouts.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

interface Guardrails {
    maxWorksPerRun: number;
    maxItemsPerWork: number;
    maxBudgetCentsPerRun: number;
    requireApprovalBeforeCreate: boolean;
    requireApprovalBeforeDelete: boolean;
    requireApprovalAboveBudgetCents: number;
    dryRunByDefault: boolean;
}

interface PreferencesDto {
    enabled: boolean;
    autoApproveLowImpact: boolean;
    dailySuggestionsEnabled: boolean;
    guardrails: Guardrails;
    autoGenerateCadence: string | null;
    autoGenerateBatchSize: number | null;
    autoBuildThrottlePerDay: number | null;
    missionDefaultOutstandingCap: number | null;
    maxAutoRetries: number;
    backoffSeconds: number;
    exponentialBackoffFactor: number;
    accountWideMonthlyCapCents: string | null;
    accountWideAllowOverage: boolean;
}

interface BuildRequestDto {
    id: string;
    instruction: string;
    status: string;
    source: string;
    dryRun: boolean;
    guardrailsOverride: Partial<Guardrails> | null;
    agentPlanSummary: string | null;
    approvalSummary: string | null;
    createdAt: string;
    updatedAt: string;
}

interface RunDto {
    id: string;
    buildRequestId: string;
    status: string;
    dryRun: boolean;
    progressPercent: number;
    summary: {
        worksPlanned: number;
        worksCreated: number;
        itemsPlanned: number;
        itemsCreated: number;
        approvalsRequired: number;
    };
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
}

interface RunLogDto {
    id: string;
    runId: string;
    level: string;
    step: string;
    message: string;
    metadata: Record<string, unknown> | null;
}

const prefsUrl = `${API_BASE}/api/me/work-agent/preferences`;
const buildRequestsUrl = `${API_BASE}/api/me/work-agent/build-requests`;
const cancelUrl = (id: string) => `${buildRequestsUrl}/${id}/cancel`;
// DEPRECATED alias routes (kept for one release window — review §23.3).
const legacyGoalsUrl = `${API_BASE}/api/me/work-agent/goals`;
const legacyCancelUrl = (id: string) => `${legacyGoalsUrl}/${id}/cancel`;
const activeRunUrl = `${API_BASE}/api/me/work-agent/runs/active`;
const runLogsUrl = (id: string) => `${API_BASE}/api/me/work-agent/runs/${id}/logs`;

let seq = 0;
function uniq(title: string): string {
    seq += 1;
    return `${title.replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}-${seq}-${Math.random()
        .toString(36)
        .slice(2, 7)}`;
}

async function getPreferences(request: APIRequestContext, token: string): Promise<PreferencesDto> {
    const res = await request.get(prefsUrl, { headers: authedHeaders(token), timeout: 30_000 });
    expect(res.status(), `getPreferences body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function putPreferences(
    request: APIRequestContext,
    token: string,
    data: Record<string, unknown>,
) {
    return request.put(prefsUrl, { headers: authedHeaders(token), data, timeout: 30_000 });
}

async function enableAgent(request: APIRequestContext, token: string): Promise<void> {
    const res = await putPreferences(request, token, { enabled: true });
    expect(res.status(), `enableAgent body=${await res.text().catch(() => '')}`).toBe(200);
    expect((await res.json()).enabled).toBe(true);
}

async function createBuildRequest(
    request: APIRequestContext,
    token: string,
    data: Record<string, unknown>,
) {
    return request.post(buildRequestsUrl, { headers: authedHeaders(token), data, timeout: 30_000 });
}

const VALID_INSTRUCTION = 'Create a Work covering the leading AI developer tools of 2026';

test.describe('Work agent (api/me/work-agent): preferences + build-request/run lifecycle + scoping', () => {
    test('1. fresh user preferences expose the well-formed default/zero Work-agent state', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-default-${uniq('d')}@test.local`,
        });
        const prefs = await getPreferences(request, owner.access_token);

        // A brand-new Work agent is OFF, with daily suggestions on, never auto-approving.
        expect(prefs.enabled, 'a new Work agent is disabled by default').toBe(false);
        expect(prefs.autoApproveLowImpact).toBe(false);
        expect(prefs.dailySuggestionsEnabled).toBe(true);

        // The conservative hardcoded guardrail defaults (DEFAULT_WORK_AGENT_GUARDRAILS).
        expect(prefs.guardrails).toEqual({
            maxWorksPerRun: 1,
            maxItemsPerWork: 50,
            maxBudgetCentsPerRun: 0,
            requireApprovalBeforeCreate: true,
            requireApprovalBeforeDelete: true,
            requireApprovalAboveBudgetCents: 0,
            dryRunByDefault: true,
        });

        // The 9 promoted top-level knobs — nullable cadence/batch knobs start null,
        // the NOT-NULL retry/backoff/overage knobs carry their column defaults.
        expect(prefs.autoGenerateCadence).toBeNull();
        expect(prefs.autoGenerateBatchSize).toBeNull();
        expect(prefs.autoBuildThrottlePerDay).toBeNull();
        expect(prefs.missionDefaultOutstandingCap).toBeNull();
        expect(prefs.maxAutoRetries).toBe(2);
        expect(prefs.backoffSeconds).toBe(60);
        expect(prefs.exponentialBackoffFactor).toBe(2);
        expect(prefs.accountWideMonthlyCapCents).toBeNull();
        expect(prefs.accountWideAllowOverage).toBe(true);
    });

    test('2. PUT preferences is a partial merge: enabled flips, one guardrail sub-key merges, promoted knobs round-trip', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-merge-${uniq('m')}@test.local`,
        });
        const token = owner.access_token;

        // Flip enabled + raise ONE guardrail sub-key + set TWO promoted knobs.
        const first = await putPreferences(request, token, {
            enabled: true,
            maxWorksPerRun: 4,
            maxAutoRetries: 5,
            autoGenerateBatchSize: 7,
        });
        expect(first.status(), `first put body=${await first.text().catch(() => '')}`).toBe(200);
        const a = (await first.json()) as PreferencesDto;
        expect(a.enabled).toBe(true);
        // The touched guardrail sub-key moved; its SIBLINGS kept their defaults
        // (a merge into the nested block, not a wholesale replace).
        expect(a.guardrails.maxWorksPerRun).toBe(4);
        expect(a.guardrails.maxItemsPerWork).toBe(50);
        expect(a.guardrails.dryRunByDefault).toBe(true);
        expect(a.maxAutoRetries).toBe(5);
        expect(a.autoGenerateBatchSize).toBe(7);

        // A SECOND partial write touches a different knob; the prior changes survive.
        const second = await putPreferences(request, token, { backoffSeconds: 120 });
        expect(second.status()).toBe(200);
        const b = (await second.json()) as PreferencesDto;
        expect(b.backoffSeconds).toBe(120);
        expect(b.enabled, 'enabled survives an unrelated partial write').toBe(true);
        expect(b.guardrails.maxWorksPerRun, 'guardrail survives an unrelated write').toBe(4);
        expect(b.maxAutoRetries, 'retry knob survives an unrelated write').toBe(5);

        // A fresh GET confirms persistence (not just the echo of the write).
        const persisted = await getPreferences(request, token);
        expect(persisted.enabled).toBe(true);
        expect(persisted.guardrails.maxWorksPerRun).toBe(4);
        expect(persisted.backoffSeconds).toBe(120);
        expect(persisted.autoGenerateBatchSize).toBe(7);
    });

    test('3. PUT preferences validation: cadence pattern, retry/guardrail caps, cents-string, unknown key are all 400', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-pvalid-${uniq('v')}@test.local`,
        });
        const token = owner.access_token;

        const badBodies: Array<{ label: string; data: Record<string, unknown> }> = [
            {
                label: 'cadence not in */N * * * * form',
                data: { autoGenerateCadence: 'every 5 minutes' },
            },
            { label: 'maxAutoRetries above the 5 cap', data: { maxAutoRetries: 6 } },
            { label: 'guardrail maxWorksPerRun above the 25 cap', data: { maxWorksPerRun: 99 } },
            { label: 'guardrail maxItemsPerWork below the 1 floor', data: { maxItemsPerWork: 0 } },
            {
                label: 'accountWideMonthlyCapCents not a digit-string',
                data: { accountWideMonthlyCapCents: 'abc' },
            },
            { label: 'unknown body key (forbidNonWhitelisted)', data: { bogusKnob: true } },
        ];
        for (const { label, data } of badBodies) {
            const res = await putPreferences(request, token, data);
            expect(res.status(), `${label} must be a 400`).toBe(400);
        }

        // A VALID cadence is accepted and round-trips verbatim (the positive of #1).
        const ok = await putPreferences(request, token, { autoGenerateCadence: '*/30 * * * *' });
        expect(ok.status()).toBe(200);
        expect((await ok.json()).autoGenerateCadence).toBe('*/30 * * * *');

        // None of the rejected writes mutated the row — guardrails are still default.
        const after = await getPreferences(request, token);
        expect(after.guardrails.maxWorksPerRun, 'rejected guardrail edit never persisted').toBe(1);
        expect(after.maxAutoRetries, 'rejected retry edit never persisted').toBe(2);
        expect(after.accountWideMonthlyCapCents, 'rejected cents edit never persisted').toBeNull();
    });

    test('4. POST build request is gated by the enable flag: disabled → 400, enabling unlocks the same body', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-gate-${uniq('g')}@test.local`,
        });
        const token = owner.access_token;

        // Default-disabled agent rejects the build request with the enable-gate message.
        const blocked = await createBuildRequest(request, token, {
            instruction: VALID_INSTRUCTION,
        });
        expect(blocked.status(), 'build request blocked while the agent is disabled').toBe(400);
        expect((await blocked.json()).message).toBe('Work agent is disabled.');

        // The list is still empty — the blocked build request was never persisted.
        const empty = await request.get(buildRequestsUrl, {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(empty.status()).toBe(200);
        expect((await empty.json()) as BuildRequestDto[]).toEqual([]);

        // Enable, then the SAME body is accepted (202 Accepted on the controller).
        await enableAgent(request, token);
        const ok = await createBuildRequest(request, token, { instruction: VALID_INSTRUCTION });
        expect(ok.status(), `enabled build request body=${await ok.text().catch(() => '')}`).toBe(
            202,
        );
    });

    test('5. POST build request DTO validation: short/missing instruction, unknown key, and the un-whitelisted ideaId are 400', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-gvalid-${uniq('gv')}@test.local`,
        });
        const token = owner.access_token;
        // Enable first so we know a 400 is the DTO talking, not the enable-gate.
        await enableAgent(request, token);

        const tooShort = await createBuildRequest(request, token, { instruction: 'short' });
        expect(tooShort.status()).toBe(400);
        expect(JSON.stringify((await tooShort.json()).message)).toContain(
            'instruction must be longer than or equal to 10 characters',
        );

        const missing = await createBuildRequest(request, token, {});
        expect(missing.status()).toBe(400);

        const unknownKey = await createBuildRequest(request, token, {
            instruction: VALID_INSTRUCTION,
            bogus: 'x',
        });
        expect(unknownKey.status(), 'unknown build-request key rejected').toBe(400);
        expect(JSON.stringify((await unknownKey.json()).message)).toContain(
            'property bogus should not exist',
        );

        // `ideaId` exists on the service input interface but is NOT declared on
        // CreateWorkBuildRequestDto — so forbidNonWhitelisted rejects it. Pinning the
        // gap so a future DTO that adds ideaId is a conscious contract change.
        const idea = await createBuildRequest(request, token, {
            instruction: VALID_INSTRUCTION,
            ideaId: UNKNOWN_UUID,
        });
        expect(idea.status(), 'un-whitelisted ideaId rejected').toBe(400);
        expect(JSON.stringify((await idea.json()).message)).toContain(
            'property ideaId should not exist',
        );

        // Nothing in this test created a real build request.
        const listed = (await (
            await request.get(buildRequestsUrl, { headers: authedHeaders(token), timeout: 30_000 })
        ).json()) as BuildRequestDto[];
        expect(listed).toEqual([]);
    });

    test('6. enabled create makes a build-request+run+logs in one transaction and surfaces across list/active/logs', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-create-${uniq('c')}@test.local`,
        });
        const token = owner.access_token;
        await enableAgent(request, token);

        const res = await createBuildRequest(request, token, { instruction: VALID_INSTRUCTION });
        expect(res.status(), `create build request body=${await res.text().catch(() => '')}`).toBe(
            202,
        );
        const { buildRequest, run } = (await res.json()) as {
            buildRequest: BuildRequestDto;
            run: RunDto;
        };

        // BUILD-REQUEST contract: approval-gated, user-sourced, trimmed instruction, dryRun
        // defaults to the pref guardrail's dryRunByDefault (true), no override set.
        expect(buildRequest.id).toMatch(UUID_RE);
        expect(buildRequest.status).toBe('waiting-for-approval');
        expect(buildRequest.source).toBe('user');
        expect(buildRequest.instruction).toBe(VALID_INSTRUCTION);
        expect(buildRequest.dryRun, 'dryRun inherits dryRunByDefault=true').toBe(true);
        expect(
            buildRequest.guardrailsOverride,
            'no guardrail keys on the body ⇒ null override',
        ).toBeNull();
        expect(buildRequest.agentPlanSummary).toContain('dry-run');
        expect(buildRequest.approvalSummary).toContain('Dry-run plan prepared');

        // RUN contract: mirrors the build request, born waiting-for-approval at 10%, with a
        // planning summary rollup (nothing actually created — keyless CI).
        expect(run.id).toMatch(UUID_RE);
        expect(run.buildRequestId).toBe(buildRequest.id);
        expect(run.status).toBe('waiting-for-approval');
        expect(run.dryRun).toBe(true);
        expect(run.progressPercent).toBe(10);
        expect(run.summary.worksPlanned).toBe(1);
        expect(run.summary.worksCreated).toBe(0);
        expect(run.summary.itemsCreated).toBe(0);
        expect(run.summary.approvalsRequired).toBe(1);
        expect(run.finishedAt).toBeNull();

        // The build request shows up at the head of the DESC list.
        const list = (await (
            await request.get(buildRequestsUrl, { headers: authedHeaders(token), timeout: 30_000 })
        ).json()) as BuildRequestDto[];
        expect(list[0]?.id, 'newest build request is first (DESC)').toBe(buildRequest.id);

        // The run is THE active run.
        const activeRes = await request.get(activeRunUrl, {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(activeRes.status()).toBe(200);
        const active = (await activeRes.json()) as RunDto | null;
        expect(active?.id, 'the new run is the active run').toBe(run.id);

        // Two seeded INFO logs explain the plan + the required approval.
        const logsRes = await request.get(runLogsUrl(run.id), {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(logsRes.status()).toBe(200);
        const logs = (await logsRes.json()) as RunLogDto[];
        const steps = logs.map((l) => l.step);
        expect(steps, 'plan + approval logs seeded in order').toEqual([
            'plan-prepared',
            'approval-required',
        ]);
        expect(logs.every((l) => l.level === 'info' && l.runId === run.id)).toBe(true);
        // The plan-prepared log carries the effective guardrails in metadata.
        expect(logs[0].metadata).toMatchObject({ dryRun: true });
    });

    test('7. guardrail-override is recorded on the build request and dryRun:false flips to live, without touching stored prefs', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-override-${uniq('o')}@test.local`,
        });
        const token = owner.access_token;
        await enableAgent(request, token);

        // Live build request carrying a PARTIAL guardrail override on the body.
        const res = await createBuildRequest(request, token, {
            instruction: 'Run a live build with elevated per-run guardrails for this probe',
            dryRun: false,
            maxWorksPerRun: 5,
            requireApprovalBeforeCreate: false,
        });
        expect(
            res.status(),
            `override build request body=${await res.text().catch(() => '')}`,
        ).toBe(202);
        const { buildRequest, run } = (await res.json()) as {
            buildRequest: BuildRequestDto;
            run: RunDto;
        };

        // dryRun:false flips both the build-request flag and the plan/approval copy to live.
        expect(buildRequest.dryRun).toBe(false);
        expect(run.dryRun).toBe(false);
        expect(buildRequest.agentPlanSummary).toContain('live');
        expect(buildRequest.approvalSummary).toContain('Live execution requires approval');

        // Only the SUPPLIED guardrail keys are captured in guardrailsOverride
        // (untouched keys are absent, not defaulted into the override blob).
        expect(buildRequest.guardrailsOverride).toEqual({
            maxWorksPerRun: 5,
            requireApprovalBeforeCreate: false,
        });

        // The override is request-scoped: the user's STORED preference guardrails are
        // untouched (still the conservative defaults).
        const prefs = await getPreferences(request, token);
        expect(prefs.guardrails.maxWorksPerRun, 'override did not leak into stored prefs').toBe(1);
        expect(prefs.guardrails.requireApprovalBeforeCreate, 'stored prefs untouched').toBe(true);
        expect(prefs.guardrails.dryRunByDefault, 'stored dryRunByDefault untouched').toBe(true);
    });

    test('8. cancel flips the build request + its active run to canceled, then a re-cancel is a terminal-state 400', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-cancel-${uniq('cx')}@test.local`,
        });
        const token = owner.access_token;
        await enableAgent(request, token);

        const created = (await (
            await createBuildRequest(request, token, { instruction: VALID_INSTRUCTION })
        ).json()) as { buildRequest: BuildRequestDto; run: RunDto };
        const buildRequestId = created.buildRequest.id;
        const runId = created.run.id;

        // Precondition: the run is active before the cancel.
        const before = (await (
            await request.get(activeRunUrl, { headers: authedHeaders(token), timeout: 30_000 })
        ).json()) as RunDto | null;
        expect(before?.id).toBe(runId);

        // Cancel returns the build request flipped to 'canceled'.
        const cancelRes = await request.patch(cancelUrl(buildRequestId), {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(cancelRes.status(), `cancel body=${await cancelRes.text().catch(() => '')}`).toBe(
            200,
        );
        expect((await cancelRes.json()).status).toBe('canceled');

        // The active run was cancelled alongside the build request ⇒ no active run remains.
        const afterRes = await request.get(activeRunUrl, {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(afterRes.status()).toBe(200);
        const afterText = await afterRes.text();
        // getActiveRun returns null ⇒ empty body (no active run).
        expect(
            afterText.trim() === '' || afterText.trim() === 'null',
            `no active run after cancel (got "${afterText}")`,
        ).toBe(true);

        // A SECOND cancel on the now-terminal build request is a 400 with the guard message.
        const reCancel = await request.patch(cancelUrl(buildRequestId), {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(reCancel.status(), 're-cancel of a terminal build request is 400').toBe(400);
        expect((await reCancel.json()).message).toBe(
            'Work build request can no longer be canceled.',
        );
    });

    test('9. build-requests/runs are owner-scoped + id-validated: foreign→404, unknown→404, malformed→400, anon→401', async ({
        request,
        browser,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-iso-${uniq('i')}@test.local`,
        });
        const token = owner.access_token;
        await enableAgent(request, token);

        const mine = (await (
            await createBuildRequest(request, token, { instruction: VALID_INSTRUCTION })
        ).json()) as { buildRequest: BuildRequestDto; run: RunDto };

        // A DIFFERENT authenticated user.
        const intruder = await registerUserViaAPI(request, {
            email: `e2e-wa-intruder-${uniq('x')}@test.local`,
        });
        const atk = authedHeaders(intruder.access_token);

        // Foreign cancel of my build request ⇒ opaque 404 (existence not leaked as 403).
        const foreignCancel = await request.patch(cancelUrl(mine.buildRequest.id), {
            headers: atk,
            timeout: 30_000,
        });
        expect(foreignCancel.status(), 'foreign build-request cancel denied as 404').toBe(404);
        expect((await foreignCancel.json()).message).toBe('Work build request not found.');

        // Foreign read of my run logs ⇒ opaque 404.
        const foreignLogs = await request.get(runLogsUrl(mine.run.id), {
            headers: atk,
            timeout: 30_000,
        });
        expect(foreignLogs.status(), 'foreign run-logs read denied as 404').toBe(404);
        expect((await foreignLogs.json()).message).toBe('Work agent run not found.');

        // The intruder's own build-requests list is empty — per-user isolation.
        const intruderBuildRequests = (await (
            await request.get(buildRequestsUrl, { headers: atk, timeout: 30_000 })
        ).json()) as BuildRequestDto[];
        expect(intruderBuildRequests, 'build requests are per-user isolated').toEqual([]);

        // An UNKNOWN well-formed uuid is a 404 (not a leak, not a 500).
        const ghostCancel = await request.patch(cancelUrl(UNKNOWN_UUID), {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(ghostCancel.status()).toBe(404);
        const ghostLogs = await request.get(runLogsUrl(UNKNOWN_UUID), {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(ghostLogs.status()).toBe(404);

        // A MALFORMED id is a 400 ParseUUIDPipe failure (before the service runs).
        const badCancel = await request.patch(cancelUrl('not-a-uuid'), {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(badCancel.status(), 'malformed build-request id is a 400').toBe(400);
        const badLogs = await request.get(runLogsUrl('not-a-uuid'), {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(badLogs.status(), 'malformed run id is a 400').toBe(400);

        // The owner can STILL read/cancel — the denials above were scope, not damage.
        const ownerLogs = await request.get(runLogsUrl(mine.run.id), {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(ownerLogs.status()).toBe(200);

        // ANON (empty storageState ⇒ no inherited auth cookie) is 401 on every verb.
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const anonGets: Array<{ label: string; url: string }> = [
            { label: 'preferences', url: prefsUrl },
            { label: 'build-requests', url: buildRequestsUrl },
            { label: 'runs/active', url: activeRunUrl },
            { label: 'run logs', url: runLogsUrl(mine.run.id) },
        ];
        for (const { label, url } of anonGets) {
            const res = await anon.request.get(url, { timeout: 30_000 });
            expect(res.status(), `anon GET ${label} is 401`).toBe(401);
        }
        const anonCancel = await anon.request.patch(cancelUrl(mine.buildRequest.id), {
            timeout: 30_000,
        });
        expect(anonCancel.status(), 'anon PATCH cancel is 401').toBe(401);
        const anonCreate = await anon.request.post(buildRequestsUrl, {
            data: { instruction: VALID_INSTRUCTION },
            timeout: 30_000,
        });
        expect(anonCreate.status(), 'anon POST build request is 401').toBe(401);
        await anon.close();
    });

    test('10. runs/active is empty for a fresh agent and for one whose only build request was canceled', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-active-${uniq('a')}@test.local`,
        });
        const token = owner.access_token;

        // Fresh agent (no build requests yet): no active run — empty body, 200.
        const fresh = await request.get(activeRunUrl, {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(fresh.status()).toBe(200);
        const freshText = (await fresh.text()).trim();
        expect(
            freshText === '' || freshText === 'null',
            `fresh agent has no active run (got "${freshText}")`,
        ).toBe(true);

        // Create then cancel the sole build request; the active run drains back to empty.
        await enableAgent(request, token);
        const created = (await (
            await createBuildRequest(request, token, { instruction: VALID_INSTRUCTION })
        ).json()) as { buildRequest: BuildRequestDto; run: RunDto };
        const activeMid = (await (
            await request.get(activeRunUrl, { headers: authedHeaders(token), timeout: 30_000 })
        ).json()) as RunDto | null;
        expect(activeMid?.id, 'run is active between create and cancel').toBe(created.run.id);

        const cancel = await request.patch(cancelUrl(created.buildRequest.id), {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(cancel.status()).toBe(200);

        const drained = await request.get(activeRunUrl, {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(drained.status()).toBe(200);
        const drainedText = (await drained.text()).trim();
        expect(
            drainedText === '' || drainedText === 'null',
            `active run drains to empty after cancel (got "${drainedText}")`,
        ).toBe(true);
    });

    test('11. multiple build requests accumulate in the list and getActiveRun returns a single in-flight run', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-multi-${uniq('mm')}@test.local`,
        });
        const token = owner.access_token;
        await enableAgent(request, token);

        const g1 = (await (
            await createBuildRequest(request, token, {
                instruction: 'First queued Work-agent build request for the accumulation probe',
            })
        ).json()) as { buildRequest: BuildRequestDto; run: RunDto };
        const g2 = (await (
            await createBuildRequest(request, token, {
                instruction: 'Second queued Work-agent build request for the accumulation probe',
            })
        ).json()) as { buildRequest: BuildRequestDto; run: RunDto };
        expect(g1.buildRequest.id).not.toBe(g2.buildRequest.id);
        expect(g1.run.id).not.toBe(g2.run.id);

        // listBuildRequests returns BOTH requests (DESC by createdAt — but createdAt is
        // second-granular, so two rapid creates can share a second and the
        // intra-second tiebreak is non-deterministic; we therefore pin SET
        // membership, not the head, to stay flake-free).
        const list = (await (
            await request.get(buildRequestsUrl, { headers: authedHeaders(token), timeout: 30_000 })
        ).json()) as BuildRequestDto[];
        const ids = list.map((g) => g.id);
        expect(ids, 'both build requests present in the list').toEqual(
            expect.arrayContaining([g1.buildRequest.id, g2.buildRequest.id]),
        );
        expect(ids.length, 'exactly the two created build requests for this fresh user').toBe(2);
        // Every listed build request is approval-gated + user-sourced (the create contract).
        expect(list.every((g) => g.status === 'waiting-for-approval' && g.source === 'user')).toBe(
            true,
        );

        // getActiveRun returns a SINGLE active run (findOne) — it is one of the two
        // runs we just created, carrying the in-flight contract (10% / waiting).
        const active = (await (
            await request.get(activeRunUrl, { headers: authedHeaders(token), timeout: 30_000 })
        ).json()) as RunDto | null;
        expect([g1.run.id, g2.run.id], 'active run is one of the created runs').toContain(
            active?.id,
        );
        expect([g1.buildRequest.id, g2.buildRequest.id]).toContain(active?.buildRequestId);
        expect(active?.status).toBe('waiting-for-approval');
        expect(active?.progressPercent).toBe(10);
    });

    test('12. account-wide budget knobs round-trip (cap digit-string + overage flag) independent of the build pipeline', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-budget-${uniq('b')}@test.local`,
        });
        const token = owner.access_token;

        // A digit-STRING cap persists verbatim (BigInt-as-string contract), and the
        // overage flag toggles — these are stored on the same prefs row as the
        // agent enable flag but are orthogonal to it.
        const set = await putPreferences(request, token, {
            accountWideMonthlyCapCents: '500000',
            accountWideAllowOverage: false,
        });
        expect(set.status(), `budget put body=${await set.text().catch(() => '')}`).toBe(200);
        const body = (await set.json()) as PreferencesDto;
        expect(body.accountWideMonthlyCapCents).toBe('500000');
        expect(body.accountWideAllowOverage).toBe(false);

        // Resetting the cap to null via the tri-state path clears it; overage flips back.
        const cleared = await putPreferences(request, token, {
            accountWideMonthlyCapCents: null,
            accountWideAllowOverage: true,
        });
        expect(cleared.status()).toBe(200);
        const clearedBody = (await cleared.json()) as PreferencesDto;
        expect(clearedBody.accountWideMonthlyCapCents, 'null clears the cap').toBeNull();
        expect(clearedBody.accountWideAllowOverage).toBe(true);

        // A fresh GET confirms persistence and that the agent stayed disabled
        // throughout (budget edits never implicitly enable the agent).
        const persisted = await getPreferences(request, token);
        expect(persisted.accountWideMonthlyCapCents).toBeNull();
        expect(persisted.enabled, 'budget edits do not enable the agent').toBe(false);
    });
    test('13. DEPRECATED /goals alias still serves the build-request queue (back-compat contract)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-alias-${uniq('al')}@test.local`,
        });
        const token = owner.access_token;
        await enableAgent(request, token);

        // The OLD create route still accepts a build request (202, same handler).
        const created = await request.post(legacyGoalsUrl, {
            headers: authedHeaders(token),
            data: { instruction: VALID_INSTRUCTION },
            timeout: 30_000,
        });
        expect(
            created.status(),
            `deprecated POST /goals alias body=${await created.text().catch(() => '')}`,
        ).toBe(202);
        const { buildRequest } = (await created.json()) as {
            buildRequest: BuildRequestDto;
            run: RunDto;
        };

        // The OLD list route responds 200 and shows the same queue.
        const legacyList = await request.get(legacyGoalsUrl, {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(legacyList.status(), 'deprecated GET /goals alias is 200').toBe(200);
        const rows = (await legacyList.json()) as BuildRequestDto[];
        expect(rows.map((r) => r.id)).toContain(buildRequest.id);

        // And the row is the SAME row the new primary route serves (one queue,
        // two paths — the alias delegates, it does not fork state).
        const primaryList = (await (
            await request.get(buildRequestsUrl, { headers: authedHeaders(token), timeout: 30_000 })
        ).json()) as BuildRequestDto[];
        expect(primaryList.map((r) => r.id)).toContain(buildRequest.id);

        // The OLD cancel route still cancels (200, same handler + guard).
        const legacyCancel = await request.patch(legacyCancelUrl(buildRequest.id), {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(legacyCancel.status(), 'deprecated PATCH /goals/:id/cancel alias is 200').toBe(200);
        expect((await legacyCancel.json()).status).toBe('canceled');
    });
});
