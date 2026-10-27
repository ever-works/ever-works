import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type {
    AppBlueprintRunMode,
    AppBlueprintUpgradePr,
    AppSpecIssue,
    AppSpecValidationStatus,
    WorkAppSpecStateDto,
} from '@ever-works/contracts';

/**
 * APW-03 T16 — server-only client for the App spec surfaces
 * (`apps/api/src/works/work-app-spec.controller.ts`, plan §4.1:547-548).
 *
 * Two routes, exactly as [plan §4.1](../../../../../../docs/specs/features/app-works/APW-03-app-spec-and-catalog/plan.md)
 * writes them:
 *
 *   - `GET  /api/works/:id/app-spec`          → {@link WorkAppSpecStateDto}
 *   - `POST /api/works/:id/app-spec/validate` → `202 { evaluationPending: true }`
 *                                               or `200 { issues, status, truncated }`
 *
 * This module is `server-only`: the tab's page is a server component and the
 * Re-check button reaches the API through `recheckAppSpecAction`, so nothing
 * here belongs in a client bundle. The DTO itself is the shared contract
 * (`@ever-works/contracts` → `work-app-spec.dto.ts`) rather than a local mirror,
 * so the field names cannot drift from the API's.
 *
 * NO leading `/api` in the paths below: `serverFetch` / `serverMutation`
 * prepend `API_URL`, which `lib/constants.ts` normalises to already end in
 * `/api`. Matches every other helper in this folder.
 */

/**
 * The request body of `POST /api/works/:id/app-spec/validate` (plan §4.1:548).
 *
 *  - `branch` — "Re-check now": validate the tracked branch's head and queue the
 *    evaluation job, which is why this half answers `202` with
 *    `{ evaluationPending: true }` instead of issues. **Edit** permission (it
 *    writes the Work's spec state), 6/min per Work (FR-77).
 *  - `content` — validate a document the caller pasted, **storing nothing**.
 *    **View** permission, 30/min per member, at most `APP_SPEC_FILE_MAX_BYTES`
 *    (256 KiB → `413 file_too_large`).
 */
export type AppSpecValidateInput = { source: 'branch' } | { source: 'content'; content: string };

/**
 * The `202` half of the validate response: an evaluation was queued rather than
 * run inline, so the caller polls `GET /api/works/:id/app-spec` until
 * `evaluationPending` clears (at most 24 polls, plan §5.2:617).
 */
export interface AppSpecEvaluationQueued {
    evaluationPending: true;
}

/**
 * The `200` half of the validate response — the inline result of a `content`
 * validation (plan §4.1:548: `{ issues, status, truncated }`).
 *
 * `status` is the plan's own field name for that response. The **state** DTO
 * spells the same idea `validationStatus`; the two are deliberately kept as the
 * plan writes them rather than reconciled here, because renaming either one
 * would be a contract change this task does not own (APW-03 T15 owns the
 * controller that emits it). See the finding in T16's report.
 *
 * The plan's three fields are the whole of what T16 reads. The controller that
 * landed alongside this client (`apps/api/src/works/dto/app-spec.dto.ts:457-481`)
 * answers a **superset** — `workId`, `errorCount`, `warningCount`, `rulesRan`
 * and `suppressedRules` as well — so a later consumer (APW-04's editor) can
 * widen this interface additively; nothing here denies those fields.
 */
export interface AppSpecContentValidation {
    /** The issues the pasted document produced (empty when it is valid). */
    issues: readonly AppSpecIssue[];
    /** `valid` · `valid_with_warnings` · `invalid` · `missing` · `unreadable`. */
    status: AppSpecValidationStatus;
    /** `true` when the `APP_SPEC_MAX_ISSUES` cap cut the list. */
    truncated: boolean;
}

/** Either half of the `validate` response, discriminated by `evaluationPending`. */
export type AppSpecValidateResult = AppSpecEvaluationQueued | AppSpecContentValidation;

/**
 * APW-03 T29/T31 (lane aw-blueprints) — what `POST …/app-spec/blueprint` and
 * `…/blueprint/upgrade` answer: `queued` (202) or `existing` (200, the open pull
 * request for that version).
 */
export interface AppBlueprintRunAccepted {
    status: 'queued' | 'existing';
    mode: AppBlueprintRunMode;
    blueprintId: string;
    version: string;
    applyStatus?: 'applying';
    runId?: string | null;
    pullRequest?: AppBlueprintUpgradePr;
}

export const workAppSpecAPI = {
    /** `GET /api/works/:id/app-spec` — the App Work's spec state (view). */
    get: async (workId: string): Promise<WorkAppSpecStateDto> => {
        return serverFetch<WorkAppSpecStateDto>(`/works/${workId}/app-spec`);
    },

    /**
     * `POST /api/works/:id/app-spec/validate` — queue an evaluation of the
     * tracked branch (`{ source: 'branch' }`) or validate a document inline
     * (`{ source: 'content', content }`).
     *
     * A `422 { code: 'notAnAppWork' }` for a non-`app` Work, `413` for an
     * oversized `content` and `429` past the throttle arrive as thrown
     * `ApiResponseError`s with `statusCode` / `code` intact — the caller
     * decides what to say, this client never swallows them.
     */
    validate: async (
        workId: string,
        input: AppSpecValidateInput,
    ): Promise<AppSpecValidateResult> => {
        return serverMutation<AppSpecValidateResult>({
            endpoint: `/works/${workId}/app-spec/validate`,
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },
    /**
     * `POST /api/works/:id/app-spec/blueprint` — apply a Blueprint to an App Work that
     * has none (edit). A refusal (`404 blueprintNotFound`, `409 applyInProgress` /
     * `blueprintAlreadyApplied`, `429`) arrives as a thrown `ApiResponseError`.
     */
    applyBlueprint: async (
        workId: string,
        input: { blueprintId: string; version?: string },
    ): Promise<AppBlueprintRunAccepted> => {
        return serverMutation<AppBlueprintRunAccepted>({
            endpoint: `/works/${workId}/app-spec/blueprint`,
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    /** `POST /api/works/:id/app-spec/blueprint/upgrade` — propose an upgrade (edit). */
    upgradeBlueprint: async (
        workId: string,
        input: { version?: string },
    ): Promise<AppBlueprintRunAccepted> => {
        return serverMutation<AppBlueprintRunAccepted>({
            endpoint: `/works/${workId}/app-spec/blueprint/upgrade`,
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    /** `POST /api/works/:id/app-spec/blueprint/dismiss` — hide one version's notice (edit). */
    dismissBlueprintUpgrade: async (
        workId: string,
        input: { version: string },
    ): Promise<{ status: 'dismissed'; version: string }> => {
        return serverMutation<{ status: 'dismissed'; version: string }>({
            endpoint: `/works/${workId}/app-spec/blueprint/dismiss`,
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },
};
