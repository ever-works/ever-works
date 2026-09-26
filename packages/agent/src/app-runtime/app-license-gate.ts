/**
 * APW-06 T21 — the license gate **per deploy target** (plan §5.2, spec FR-9 /
 * ACC-06-39, Resolution R-3).
 *
 * ## What this file is, and what it deliberately is not
 *
 * It is the one place that turns APW-03's hosting eligibility into APW-06's
 * refusal codes. Plan §5.2 states both halves of that contract:
 *
 * | Eligibility field                     | Precondition                  | What APW-03 decides behind it                                                      |
 * | ------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
 * | `yourCluster = 'attestationRequired'` | `license_attestation_missing` | amber, red, unknown until the owner attests (re-required on license change)         |
 * | `managed ≠ 'allowed'` (reason)        | `license_blocks_target`       | red never; amber only with a recorded upstream agreement; P2 verified Blueprint     |
 * | `sourceOffer`                         | — (feeds §4.7 / T30)          | `network-source-offer` obligation **and** (relation `link` **or** ahead > 0)        |
 *
 * It is **not** an attestation store, and it never becomes one. R-3
 * (`CONTRACTS.md` §0:46) and C3 make the attestation APW-03's single record,
 * `work_app_runtime_states` carries no attestation column (plan §7.2, asserted by
 * T17), and plan §5.2 repeats it for this epic: "The gate is **read, never
 * stored**". ACC-06-39 is the acceptance criterion, and this file's spec proves it
 * two ways — no write path is reachable from here, and no repository type is even
 * imported.
 *
 * ## The read is fresh, and it is per target
 *
 * `evaluate()` reads eligibility on **every** call and caches nothing. That is
 * what makes "attestation is re-required on license change" (ACC-06-39, FR-59/FR-60)
 * true without a second mechanism: APW-03 clears its own record when `spdx`,
 * `class` or `textId` differ, and the next read here simply sees
 * `attestationRequired` again. A memo here — even a short one — would let a
 * Deployment start on a licence the owner never attested to.
 *
 * Only the target being deployed to is judged: `your-cluster` reads
 * `yourCluster`, `ever-works-apps` reads `managed`, and `none` reads nothing at
 * all (it runs nothing, so no licence can refuse it — `HostingEligibility.none`
 * is `'allowed'` by construction, `app-license.types.ts:202-206`).
 *
 * ## The unbound / unreadable answer, and why the two targets differ
 *
 * APW-03's `AppLicenseService` has not landed on this branch, so the seam below is
 * a **typed fake** exactly as T21's task text allows ("the license gate reads
 * `AppLicenseService.getHostingEligibility(workId)` (APW-03; typed fake until it
 * lands)"). The swap is one binding:
 * `{ provide: APP_LICENSE_SERVICE, useExisting: AppLicenseService }`, whose method
 * already has this signature (`APW-03/tasks.md:709`).
 *
 * When no verdict can be read — the port is unbound, or it throws — the two
 * targets answer differently, and both answers are deliberate:
 *
 * - **`ever-works-apps` fails closed** (`license_blocks_target`). The managed tier
 *   is the surface D13 protects ("a license gate protects hosting"), the tier is
 *   open only for verified Blueprints even then, and hosting somebody's code
 *   without knowing its licence is not a state the platform may enter by accident.
 *   In practice APW-10's policy is unbound too, so `managed_disabled` already
 *   refuses this target — this is the second lock, not the first.
 * - **`your-cluster` refuses nothing**, and says so in `warnings`. The workload
 *   runs on infrastructure the owner controls, and an unread classification is
 *   *not evidence of an amber one*: refusing there would block Wave 1 for every
 *   installation until APW-03 merges, which is the posture APW-01 already takes
 *   for the same missing service ("injected `@Optional()` until it lands",
 *   `APW-01/plan.md:22`). The warning is the tell, so the state is visible rather
 *   than silent.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
    AppDeployTarget,
    AppPrecondition,
    HostingEligibility,
    ManagedHostingDecision,
    SourceOffer,
} from '@ever-works/contracts';

/* -------------------------------------------------------------------------- *
 * Provisional seam — APW-03 T42 `AppLicenseService`
 * -------------------------------------------------------------------------- */

// ── provisional — APW-03 T42, `packages/agent/src/app-license/` ──────────────
//
// `AppLicenseService` (`APW-03/tasks.md:696-717`) does not exist in this tree. The
// narrowest reading of it this task needs is the one method plan §5.2 names, with
// APW-03's own signature — `getHostingEligibility(workId, opts?: { commitSha?: string })`
// — and APW-03's own return shape, which is the **shared** `HostingEligibility`
// from `@ever-works/contracts` (`packages/contracts/src/apps/app-license.types.ts:208-213`,
// R-1: imported, never redeclared).
//
// The token is declared here because no other file in this package declares one
// for this service; when APW-03 lands, this declaration is replaced by
// `{ provide: APP_LICENSE_SERVICE, useExisting: AppLicenseService }` in the
// module that owns the App runtime ports — nothing in this file changes, and no
// second `Symbol('APP_LICENSE_SERVICE')` is created anywhere.

/** APW-03 T42's `AppLicenseService`, as the license gate consumes it. */
export interface AppLicenseService {
    /**
     * What each target is allowed to do with this App Work, read fresh.
     *
     * `null` means "no verdict could be produced" — an unreadable state, never a
     * licence class. A `red` class is *not* `null`: it is a verdict, and it arrives
     * as `managed: 'licenseNotGreen'`.
     */
    getHostingEligibility(
        workId: string,
        opts?: { commitSha?: string },
    ): Promise<HostingEligibility | null>;
}

/** DI token for {@link AppLicenseService} — owned by APW-03 T42. */
export const APP_LICENSE_SERVICE = Symbol('APP_LICENSE_SERVICE');

/* -------------------------------------------------------------------------- *
 * Shapes
 * -------------------------------------------------------------------------- */

/** The warning code this file emits when no eligibility could be read. */
export const LICENSE_ELIGIBILITY_UNAVAILABLE = 'license_eligibility_unavailable';

/** One request-time warning — `{ code, message }`, the shape §5.4's warnings already use. */
export interface AppLicenseWarning {
    code: string;
    message: string;
}

/** What the gate is asked. */
export interface AppLicenseGateRequest {
    workId: string;
    /** The target the Deployment (or the target-save) is for. */
    target: AppDeployTarget;
    /**
     * The commit the Deployment will run, when it is known: APW-03's
     * `getHostingEligibility(workId, { commitSha })` answers for a specific commit
     * (FR-19g), which is what keeps the verdict and the App spec on one commit
     * (ACC-06-20).
     */
    commitSha?: string | null;
}

/** What the gate answers. */
export interface AppLicenseGateResult {
    /** `true` ⇔ `preconditions` is empty. */
    allowed: boolean;
    /** The refusals, in `AppPrecondition` shape — `422 { code: 'APP_DEPLOY_PRECONDITIONS', unmet }`. */
    preconditions: AppPrecondition[];
    /** Read-only echo for the caller's row and the Deploy tab; never stored by this epic (R-3). */
    eligibility: HostingEligibility | null;
    /** §5.2's third row: T30 renders **Source** from this — the gate itself refuses nothing over it. */
    sourceOffer: SourceOffer | null;
    warnings: AppLicenseWarning[];
}

/* -------------------------------------------------------------------------- *
 * The mapping, as a pure function (plan §5.2's table)
 * -------------------------------------------------------------------------- */

/**
 * Plan §5.2's table, applied to one eligibility and one target.
 *
 * Pure, and exported, for two reasons: a caller that already holds an eligibility
 * (the `GET/PUT app-target` routes render it, plan §9.1:1211-1214) can map it
 * without a second read, and the mapping itself is testable without a DI
 * container — the same posture APW-03 takes for `managedHostingAvailability`
 * ("purity is part of the contract, not a style preference").
 *
 * `workId` is used only to make the message name the Work it is about; it never
 * reaches the network and is never logged.
 */
export function licensePreconditionsForTarget(
    eligibility: HostingEligibility | null | undefined,
    target: AppDeployTarget,
    workId: string,
): { preconditions: AppPrecondition[]; warnings: AppLicenseWarning[] } {
    const preconditions: AppPrecondition[] = [];
    const warnings: AppLicenseWarning[] = [];

    // Target **None** runs nothing (R-12), so there is no target for a licence to
    // refuse — and no read to make.
    if (target === 'none') {
        return { preconditions, warnings };
    }

    if (!eligibility) {
        warnings.push({
            code: LICENSE_ELIGIBILITY_UNAVAILABLE,
            message:
                'The license classification could not be read, so the target was judged without it. ' +
                'Ever Works Apps refuses in this state; your own cluster does not.',
        });

        if (target === 'ever-works-apps') {
            preconditions.push({
                code: 'license_blocks_target',
                message:
                    'Ever Works Apps cannot host this App Work while its license classification is ' +
                    'unreadable. An eligible classification must be read before the managed target ' +
                    'may run the code.',
            });
        }

        return { preconditions, warnings };
    }

    if (target === 'your-cluster') {
        if (eligibility.yourCluster === 'attestationRequired') {
            // §5.2 row 1. The eligibility already accounts for a *valid* attestation
            // (APW-03 clears its own record when the classified licence changes), so
            // this code means "attest, or attest again" and never "attest twice".
            preconditions.push({
                code: 'license_attestation_missing',
                message:
                    "This App Work's license requires the owner's attestation before it can run on " +
                    'a cluster the owner supplies. Only the App Work’s owner can attest.',
            });
        }

        return { preconditions, warnings };
    }

    // `target === 'ever-works-apps'` — the managed tier (P2, APW-10's gate).
    if (eligibility.managed !== 'allowed') {
        const reason = eligibility.managed as ManagedHostingDecision;
        preconditions.push({
            code: 'license_blocks_target',
            // `names` carries the *reason*, the same way §5.1 writes
            // "`managed_ineligible` (+ reasons)": the Deploy tab shows why the target
            // is disabled, and a reason is a name a person reads, not a value.
            names: [String(reason)],
            message:
                'Ever Works Apps may not host this App Work under its current license ' +
                `classification (${String(reason)}). Your own cluster remains available.`,
        });
    }

    return { preconditions, warnings };
}

/* -------------------------------------------------------------------------- *
 * The gate
 * -------------------------------------------------------------------------- */

/**
 * The read side of plan §5.2. Constructed wherever a Deployment may be requested
 * or started (the API's request path and `app-deploy`'s §5.6 step-1 re-check —
 * "preconditions are checked on request and again when work starts", FR-24).
 */
@Injectable()
export class AppLicenseGate {
    private readonly logger = new Logger(AppLicenseGate.name);

    constructor(
        // `@Optional()`, like every other App runtime collaborator: a lean worker
        // context and this file's own spec construct the gate with nothing bound,
        // and the unbound answer is the documented one above rather than a crash.
        @Optional()
        @Inject(APP_LICENSE_SERVICE)
        private readonly licenses?: AppLicenseService,
    ) {}

    /**
     * Read APW-03's eligibility for this Work and target, and map it.
     *
     * Never throws: an unbound port is the documented unreadable answer, and a
     * port that throws is caught and treated the same way — a licence service that
     * is down must not become a 500 on the deploy route, which is exactly the
     * failure `AppPortUnavailableError` exists to prevent one layer down.
     */
    async evaluate(request: AppLicenseGateRequest): Promise<AppLicenseGateResult> {
        const workId = String(request?.workId ?? '');
        const target = request?.target;
        const commitSha = request?.commitSha ?? null;

        if (target === 'none') {
            return {
                allowed: true,
                preconditions: [],
                eligibility: null,
                sourceOffer: null,
                warnings: [],
            };
        }

        const eligibility = await this.readEligibility(workId, commitSha);
        const mapped = licensePreconditionsForTarget(eligibility, target, workId);

        if (!eligibility) {
            this.logger.warn(
                `No hosting eligibility is available for App Work ${workId} (target ${String(target)}), ` +
                    `so the license gate reports ${LICENSE_ELIGIBILITY_UNAVAILABLE} and judges nothing ` +
                    `it cannot read.`,
            );
        }

        return {
            allowed: mapped.preconditions.length === 0,
            preconditions: mapped.preconditions,
            eligibility,
            // Read-only echo. Deliberately **not** used to refuse anything: §5.2
            // gives `sourceOffer` no precondition, and FR-44's obligation is
            // rendered by T30 from this same value.
            sourceOffer: eligibility?.sourceOffer ?? null,
            warnings: mapped.warnings,
        };
    }

    /** One fresh read; `null` when nothing can be read, never a guess. */
    private async readEligibility(
        workId: string,
        commitSha: string | null,
    ): Promise<HostingEligibility | null> {
        if (!this.licenses || typeof this.licenses.getHostingEligibility !== 'function') {
            return null;
        }

        try {
            const eligibility = await this.licenses.getHostingEligibility(
                workId,
                commitSha ? { commitSha } : undefined,
            );
            return eligibility ?? null;
        } catch (error) {
            this.logger.warn(
                `Reading the hosting eligibility for App Work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }); the target is judged without it.`,
            );
            return null;
        }
    }
}
