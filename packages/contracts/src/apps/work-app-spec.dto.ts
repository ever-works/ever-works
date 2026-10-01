/**
 * App Works — the **App spec state DTO**: one App Work's spec state as
 * `GET /api/works/:id/app-spec` answers it, plus the file link the problems list
 * builds from.
 *
 * Owning epic: **APW-03** (App spec, Apps catalog and license gate).
 *
 * Spec: `docs/specs/features/app-works/APW-03-app-spec-and-catalog/spec.md`
 * FR-17 (one state per App Work), FR-21 (the effective spec) and FR-66…FR-70
 * (the App spec tab). Plan: `.../plan.md` §3.1:397-452 is the table this DTO
 * mirrors — "state minus internal seq columns, plus `evaluationPending`,
 * `links.file(line)` builder input" (§3.2:469) — and §4.3:578-582 fixes the link
 * shape. `.../schema.md` §23 is the issue object's authority and
 * `app-spec.types.ts` the spec's. Bindings:
 * `docs/specs/features/app-works/CONTRACTS.md` §2A (:321) and **R-26** (additive
 * only: a field is added, never removed or narrowed).
 *
 * **Everything but the five sequence columns is carried.** The state table's
 * `requestedSeq` / `startedSeq` / `evaluatedSeq` / `licenseRequestedSeq` /
 * `licenseEvaluatedSeq` are the coalescing arithmetic of plan §2.3 and mean
 * nothing outside the repository that owns them; `evaluationPending` is their
 * one useful projection (`evaluatedSeq < requestedSeq`). The scope stamps and
 * the three digest columns stay in the DTO because the DTO **is** the state's
 * public shape — a consumer that ignores a field costs nothing, while dropping
 * one would be a removal (R-26).
 *
 * **The file link is data, never a URL shape.** The provider hands back
 * `{ url, lineAnchor? }` (plan §7:720) and the web appends the anchor
 * (plan §4.3:578-580) — no provider URL is ever assembled in the browser, which
 * is Constitution II in one line.
 */

import type {
	BlueprintMatchSource,
	LicenseAttestation,
	LicenseClass,
	LicenseRegistrySource,
	LicenseSource
} from './app-license.types.js';
import type { AppSpecIssue, AppSpecValidationStatus } from './app-spec-issues.js';
import type { AppSpec, AppSpecEvaluationTrigger } from './app-spec.types.js';

// ---------------------------------------------------------------------------
// The file link (plan §4.3:578-580, §7:720)
// ---------------------------------------------------------------------------

/**
 * Where `.works/works.yml` can be opened, as the API answers it
 * (plan §4.3:578-580).
 *
 * `base` is the provider's web URL for the file at `commitSha` — the call is
 * `git.getFileWebUrl(owner, repo, commitSha, path)` (plan §7:720), so the URL
 * shape belongs to the plugin and never to the web app. `path` is always the App
 * spec's own path, `APP_SOURCE_SPEC_FILE` (app-source.ts:109, schema.md §0).
 */
export interface WorkAppSpecFileLink {
	/** The provider's web URL for the file at {@link WorkAppSpecFileLink.commitSha}. */
	base: string;
	/** The commit the link points at — the head commit when one was read. */
	commitSha: string | null;
	/** Always `.works/works.yml` (`APP_SOURCE_SPEC_FILE`, app-source.ts:109). */
	path: string;
}

/**
 * The links block of the DTO (plan §4.3:578-580).
 *
 * `lineAnchor` is the provider's hint — `'#L{line}'` for GitHub (plan §7:725) —
 * or `null` when the provider offers none, in which case a problem row links to
 * the file rather than to a line. {@link buildAppSpecLineLink} is the one place
 * that template is expanded, so no caller re-implements it.
 */
export interface WorkAppSpecLinks {
	file: WorkAppSpecFileLink;
	/** The provider's line-anchor template, e.g. `'#L{line}'`; `null` when it has none. */
	lineAnchor: string | null;
}

/**
 * The URL for one problem row: the file link plus the provider's anchor for
 * `line` (plan §4.3:578-580, §5.2:619 "link via `links.file` + `lineAnchor`").
 *
 * Falls back to {@link WorkAppSpecFileLink.base} when there is no line (an issue
 * on an absent key points at the nearest parent key, schema.md §23:533), when
 * the provider returned no anchor, or when the anchor has no `{line}`
 * placeholder — a link to the file is always better than a broken one.
 */
export function buildAppSpecLineLink(links: WorkAppSpecLinks, line?: number | null): string {
	const base = links.file.base;
	const anchor = links.lineAnchor;

	if (typeof line !== 'number' || !Number.isInteger(line) || line < 1 || !anchor || !anchor.includes('{line}')) {
		return base;
	}

	return `${base}${anchor.replace('{line}', String(line))}`;
}

// ---------------------------------------------------------------------------
// The state's composite columns (plan §3.1:424-446)
// ---------------------------------------------------------------------------

/**
 * `blueprintApplyStatus` (plan §3.1:426): `applying`, `applied` or `failed`.
 *
 * `applying` is the guard that refuses a second apply with `409 applyInProgress`
 * (plan §4.2:570), and it is set by the request, not by the job
 * (plan §2.5:256-263).
 */
export const APP_BLUEPRINT_APPLY_STATUSES = ['applying', 'applied', 'failed'] as const;

/** Union derived from {@link APP_BLUEPRINT_APPLY_STATUSES}. */
export type AppBlueprintApplyStatus = (typeof APP_BLUEPRINT_APPLY_STATUSES)[number];

/**
 * `blueprintApplyRef` (plan §3.1:429): what the apply produced — a commit on a
 * fresh fork or private copy, or a pull request everywhere else (R-4,
 * plan §2.5:279-283). APW-02's readiness is told through
 * `recordSourceApplied` with exactly these three facts (T28, tasks.md:531-535).
 */
export interface AppBlueprintApplyRef {
	kind: 'commit' | 'pull_request';
	/** Present with `kind: 'commit'`. */
	sha?: string;
	/** Present with `kind: 'pull_request'`. */
	number?: number;
	url: string;
}

/**
 * `blueprintUpgradePr` (plan §3.1:432): the open upgrade pull request for a
 * newer Blueprint version, with the `breaking` flag a `MAJOR` bump sets
 * (plan §2.5:295-297, FR-51).
 */
export interface AppBlueprintUpgradePr {
	number: number;
	url: string;
	version: string;
	breaking: boolean;
}

/**
 * One header finding of the licence scan (plan §2.6:324-325, FR-54): the
 * `SPDX-License-Identifier:` / `@license` tag a file declares in its first
 * `LICENSE_HEADER_SCAN_BYTES` bytes.
 *
 * **Gap, named rather than guessed:** plan §3.1:437 writes the column's third
 * field as `headerFindings: …` without a shape. `path` is certain — it is the
 * first field of the scan's input — and the detected identifier is the second
 * fact the scan produces, so both are declared; anything further an
 * implementation adds is additive.
 */
export interface AppLicenseHeaderFinding {
	path: string;
	/** The SPDX identifier the header declares, when it declares a known one. */
	spdx?: string;
}

/**
 * `licenseEvidence` (plan §3.1:437): what the detection saw — the licence files
 * it read, the paths that made the repository **mixed**, and the header
 * findings recorded for this commit. Both path lists are capped at
 * `LICENSE_EVIDENCE_MAX` and a header finding for a commit other than
 * `licenseCommitSha` is stored but ignored (plan §9.2:834).
 */
export interface AppLicenseEvidence {
	files: readonly string[];
	mixedPaths: readonly string[];
	headerFindings?: readonly AppLicenseHeaderFinding[];
}

// ---------------------------------------------------------------------------
// The DTO (plan §3.1:397-452, §3.2:469)
// ---------------------------------------------------------------------------

/**
 * One App Work's App spec state — what `GET /api/works/:id/app-spec` returns
 * (plan §4.1:547) and what the App spec tab renders from.
 *
 * Field names and nullability are the table's, one for one, minus the five
 * sequence columns; see this module's header. `evaluationPending` is the
 * projection of the coalescing arithmetic (`evaluatedSeq < requestedSeq`,
 * plan §2.3:409) that tells the page to keep polling — at most 24 polls
 * (plan §5.2:617).
 *
 * Corrupt or never-evaluated states are first-class: `validationStatus` is
 * `missing` before the first evaluation (`'missing'` is the column default,
 * plan §3.1:413) and the effective-spec fields are `null` until one evaluation
 * has zero errors (FR-20) — a caller must never read `effectiveSpec` without
 * checking `validationStatus` first.
 */
export interface WorkAppSpecStateDto {
	/** The state row's id. */
	id: string;
	/** The App Work this state belongs to; unique. */
	workId: string;
	tenantId: string | null;
	organizationId: string | null;
	/** The branch whose head is evaluated. */
	trackedBranch: string;
	/** When the last evaluation was dispatched. */
	dispatchedAt: string | null;
	/** The head commit read on the tracked branch. */
	headCommitSha: string | null;
	/** sha256 of the canonical JSON of the head spec (sorted keys, no whitespace). */
	headSpecHash: string | null;
	validationStatus: AppSpecValidationStatus;
	/** ≤ `APP_SPEC_MAX_ISSUES` issues from the head evaluation. */
	issues: readonly AppSpecIssue[] | null;
	errorCount: number;
	warningCount: number;
	/** `true` when the 200-issue cap was reached (schema.md §2.5:79-80). */
	issuesTruncated: boolean;
	/** The commit of the last evaluation with zero errors (FR-20). */
	effectiveCommitSha: string | null;
	effectiveSpecHash: string | null;
	/** A **cache** of the spec at `effectiveCommitSha`; the file at that commit is authoritative. */
	effectiveSpec: AppSpec | null;
	effectiveAt: string | null;
	lastEvaluatedAt: string | null;
	lastEvaluationTrigger: AppSpecEvaluationTrigger | null;
	/** The provider error code for `unreadable` (plan §9.2:826-828). */
	lastEvaluationError: string | null;
	blueprintId: string | null;
	blueprintVersion: string | null;
	blueprintRepo: string | null;
	blueprintSha: string | null;
	blueprintMatchSource: BlueprintMatchSource | null;
	blueprintApplyStatus: AppBlueprintApplyStatus | null;
	/** When **Blueprint matched** was recorded for this id + version — the once-only guard (FR-82). */
	blueprintMatchedAt: string | null;
	/** The apply's reason code when it failed. */
	blueprintApplyError: string | null;
	blueprintApplyRef: AppBlueprintApplyRef | null;
	blueprintLatestVersion: string | null;
	blueprintUpgradeDismissedVersion: string | null;
	blueprintUpgradePr: AppBlueprintUpgradePr | null;
	licenseSpdx: string | null;
	licenseClass: LicenseClass | null;
	licenseSource: LicenseSource | null;
	licenseMixed: boolean;
	licenseScanIncomplete: boolean;
	licenseEvidence: AppLicenseEvidence | null;
	licenseObligations: readonly string[] | null;
	licenseCommitSha: string | null;
	/** Drives the re-classification fan-out after a registry change. */
	licenseRegistryHash: string | null;
	licenseRegistrySource: LicenseRegistrySource | null;
	licenseEvaluatedAt: string | null;
	/** The single attestation record (C3, R-3); APW-06 stores none of its own. */
	attestation: LicenseAttestation | null;
	/** A display cache for the License card; eligibility recomputes it on every call. */
	sourceOfferRequired: boolean;
	/** The Blueprint's trademark display name (FR-63). */
	displayName: string | null;
	trademarkNotice: string | null;
	/** `string[]`, ≤ `APP_SPEC_MAX_PROTECTED_PATHS` (plan §3.1:448). */
	protectedPaths: readonly string[] | null;
	createdAt: string;
	updatedAt: string;
	/** `evaluatedSeq < requestedSeq` — an evaluation is queued or running (plan §2.3:409). */
	evaluationPending: boolean;
	links: WorkAppSpecLinks;
}
