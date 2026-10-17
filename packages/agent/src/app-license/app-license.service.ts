/**
 * APW-03 T42/T43/T44 — `AppLicenseService`: the licence classification, the hosting
 * eligibility every deploy target is judged by, and the owner's attestation record.
 *
 * It binds THREE consumer seams that were declared long before it existed:
 *
 *  - `APP_LICENSE_SERVICE` (`app-runtime/app-license-gate.ts`) — APW-06's gate reads
 *    `getHostingEligibility(workId, { commitSha })`; APW-01's ready handler calls
 *    `request(workId)` once the source is on the default branch.
 *  - `APP_UPSTREAM_LICENSE_SERVICE` (`app-works/app-upstream-sync.service.ts`) — APW-02's
 *    sync asks `previewUpstream(…)` (FR-37: is upstream's head worse?) and
 *    `request(workId, 'upstream_synced')`.
 *  - the attest endpoint (`POST /api/works/:id/app-license/attest`, T44) calls `attest`.
 *
 * ## What it decides (R-3, plan §2.6)
 *
 * - **Your cluster:** `green` ⇒ `allowed`; `amber`, `red`, `unknown` ⇒
 *   `attestationRequired` until the OWNER's attestation matches the current
 *   classification (`spdx`, `class` and the registry's `textId`). A re-classification
 *   that changes any of the three clears the record (FR-59/FR-60), so the next deploy
 *   is refused `license_attestation_missing` again.
 * - **Ever Works Apps (managed):** never `allowed` while the classification comes from
 *   the bundled snapshot (FR-38 — the only registry source in this tree today) or the
 *   entry is unverified. `red`/`unknown` ⇒ `licenseNotGreen`, `amber` ⇒
 *   `upstreamAgreementMissing`, `green` ⇒ `blueprintNotVerified`. Fail-closed, and the
 *   APW-10 tier policy is a second lock in front of it anyway.
 * - **Source offer (FR-61):** required when the obligations include
 *   `network-source-offer` and the relation is `link` or `aheadBy` is null/positive
 *   (null counts as required); `url` is the tree URL at the deployed commit for a public
 *   Work Repository, else the spec's `license.sourceOfferUrl`, else `null`
 *   (`missing: true`).
 *
 * ## Where the licence comes from
 *
 * The effective App spec's declared `license.spdx` (source `blueprint`, which is what a
 * Blueprint apply writes) wins; otherwise the provider-detected SPDX of the Work
 * Repository (`getRepository().licenseSpdx`, source `detected`). Recursive tree scans,
 * header scans and the live registry (T38–T41) are still open; the bundled registry
 * snapshot classifies.
 *
 * ## Where it runs
 *
 * API-side (it reads and writes `work_app_spec_states`). The state repository is looked
 * up lazily through `ModuleRef` (`strict: false`) because the agent `AppWorksModule`
 * that provides this class deliberately does not import `AppSpecModule`. The worker
 * reaches it through the internal RPC channel by the name `AppLicenseService`.
 */
import { createHash } from 'node:crypto';
import {
    ForbiddenException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    ConflictException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { OnEvent } from '@nestjs/event-emitter';
import {
    LICENSE_CLASS_RANK,
    type AppSourceRecord,
    type HostingEligibility,
    type LicenseAttestation,
    type LicenseClass,
    type ManagedHostingDecision,
    type SourceOffer,
} from '@ever-works/contracts';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityStatus, type ActivityActionType } from '../entities/activity-log.types';
import type { WorkAppSpecState } from '../entities/work-app-spec-state.entity';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkAppSpecStateRepository } from '../database/repositories/work-app-spec-state.repository';
import { WorkUpstreamStateRepository } from '../database/repositories/work-upstream-state.repository';
import { GitFacadeService } from '../facades/git.facade';
import { getOptionalProvider } from '../utils/optional-provider.util';
import { relationOf } from '../app-works/app-source-initializer.service';
import { AppSpecAppliedEvent } from '../events/app-spec-applied.event';
import {
    applyMixed,
    detectRepositoryLicense,
    type LicenseDetectGit,
    type LicenseDetection,
} from './license-detect';
import { APPS_TIER_POLICY, type AppsTierPolicy } from '../app-runtime/ports';
import { classifyLicenseExpression, detectedLicenseSpdx } from './license-classify';
import {
    LICENSE_REGISTRY_SNAPSHOT,
    LICENSE_REGISTRY_SNAPSHOT_SOURCE,
    type LicenseRegistryAttestation,
} from './license-registry.snapshot';

/** R-2's Activity family for licence rows (a local constant, like `app_source`). */
export const APP_LICENSE_ACTIVITY_ACTION_TYPE = 'app_license';

/** CONTRACTS §6 names. */
export const APP_LICENSE_ACTIVITY_EVENTS = {
    classified: 'app.license.classified',
    changed: 'app.license.changed',
    attestationRequired: 'app.license.attestation_required',
    attested: 'app.license.attested',
} as const;

/** How many Works one registry-change fan-out re-classifies at most (T43, ACC-03-22). */
export const LICENSE_REGISTRY_FANOUT_MAX = 500;

/** The obligation that makes a source offer required (FR-61). */
export const NETWORK_SOURCE_OFFER = 'network-source-offer';

/** The T44 refusal codes. */
export const APP_LICENSE_ATTEST_CODES = {
    ownerOnly: 'ownerOnly',
    attestationNotRequired: 'attestationNotRequired',
    licenseChanged: 'licenseChanged',
    notFound: 'not_found',
} as const;

/** What one evaluation decided (also returned by `evaluate`, for the log and the tests). */
export interface AppLicenseEvaluation {
    workId: string;
    spdx: string | null;
    licenseClass: LicenseClass;
    source: 'detected' | 'blueprint';
    obligations: string[];
    changed: boolean;
    attestationCleared: boolean;
    commitSha: string | null;
}

/** The attestation text for a classification (registry row, else `unknown`'s). */
export function attestationTextFor(spdx: string | null): LicenseRegistryAttestation | null {
    const ids = licenseIdsOf(spdx);
    let best: { rank: number; attestation: LicenseRegistryAttestation } | null = null;
    for (const id of ids) {
        const row = LICENSE_REGISTRY_SNAPSHOT.licenses.find(
            (license) => license.spdx.toLowerCase() === id.toLowerCase(),
        );
        if (!row?.attestation) continue;
        const rank = LICENSE_CLASS_RANK[row.class as LicenseClass] ?? 0;
        if (!best || rank > best.rank) {
            best = { rank, attestation: row.attestation };
        }
    }
    return best?.attestation ?? LICENSE_REGISTRY_SNAPSHOT.unknown?.attestation ?? null;
}

/** The registry obligations of every id in an expression (a union, de-duplicated). */
export function obligationsFor(spdx: string | null): string[] {
    const out = new Set<string>();
    for (const id of licenseIdsOf(spdx)) {
        const row = LICENSE_REGISTRY_SNAPSHOT.licenses.find(
            (license) => license.spdx.toLowerCase() === id.toLowerCase(),
        );
        for (const obligation of row?.obligations ?? []) {
            out.add(obligation);
        }
    }
    return [...out];
}

/** The licence ids of an SPDX expression (operators and parentheses dropped). */
function licenseIdsOf(spdx: string | null): string[] {
    if (typeof spdx !== 'string' || spdx.trim() === '') return [];
    return spdx
        .replace(/[()]/g, ' ')
        .split(/\s+/)
        .filter((token) => token !== '' && !/^(AND|OR|WITH)$/i.test(token));
}

/** Does this attestation still cover the current classification? */
export function attestationIsValid(
    state: Pick<WorkAppSpecState, 'attestation' | 'licenseSpdx' | 'licenseClass'> | null,
): boolean {
    const attestation = state?.attestation;
    if (!attestation || !state) return false;
    const text = attestationTextFor(state.licenseSpdx ?? null);
    return (
        (attestation.spdx ?? '') === (state.licenseSpdx ?? '') &&
        attestation.class === (state.licenseClass ?? 'unknown') &&
        (!text || attestation.textId === text.textId)
    );
}

/** Pure eligibility (plan §2.6's table) — exported so the API can render it without a read. */
export function hostingEligibilityOf(input: {
    licenseClass: LicenseClass;
    attested: boolean;
    obligations: readonly string[];
    relation: string;
    aheadBy: number | null;
    isPublic: boolean;
    owner: string;
    repo: string;
    commitSha?: string | null;
    sourceOfferUrl?: string | null;
    registrySnapshot: boolean;
    verified: boolean;
    /**
     * APW-10 lite — the tier's `managedScope()`. `any` admits a green licence whatever its
     * Blueprint status; absent (no policy bound) or `verified-blueprints` keeps the fail-closed
     * `blueprintNotVerified` rule.
     */
    managedScope?: 'any' | 'verified-blueprints';
    /** APW-10 lite — `AppsTierPolicy.isOpen()`; `false` ⇒ `managedTierDisabled` (reason #5, last). */
    tierOpen?: boolean;
}): HostingEligibility {
    const yourCluster =
        input.licenseClass === 'green' || input.attested ? 'allowed' : 'attestationRequired';

    let managed: ManagedHostingDecision;
    if (input.licenseClass === 'red' || input.licenseClass === 'unknown') {
        managed = 'licenseNotGreen';
    } else if (input.licenseClass === 'amber') {
        managed = 'upstreamAgreementMissing';
    } else if (input.managedScope !== 'any' && (input.registrySnapshot || !input.verified)) {
        managed = 'blueprintNotVerified';
    } else if (input.tierOpen === false) {
        managed = 'managedTierDisabled';
    } else {
        managed = 'allowed';
    }

    const required =
        input.obligations.includes(NETWORK_SOURCE_OFFER) &&
        (input.relation === 'link' || input.aheadBy === null || input.aheadBy > 0);
    let url: string | null = null;
    if (required) {
        if (input.isPublic && input.commitSha) {
            url = `https://github.com/${input.owner}/${input.repo}/tree/${input.commitSha}`;
        } else if (input.sourceOfferUrl) {
            url = input.sourceOfferUrl;
        }
    }
    const sourceOffer: SourceOffer = { required, url, missing: required && url === null };

    return { none: 'allowed', yourCluster, managed, sourceOffer };
}

function errorText(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, 300);
}

function firstNonEmpty(...values: unknown[]): string | null {
    for (const value of values) {
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return null;
}

interface WorkCoordinates {
    workId: string;
    userId: string;
    owner: string;
    repo: string;
    relation: string;
    providerId: string;
}

@Injectable()
export class AppLicenseService {
    private readonly logger = new Logger(AppLicenseService.name);

    constructor(
        @Optional() private readonly works?: WorkRepository,
        @Optional() private readonly git?: GitFacadeService,
        @Optional() private readonly activity?: ActivityLogService,
        @Optional() private readonly moduleRef?: ModuleRef,
        // APW-10 lite — the managed tier's scope and switch for `hostingEligibilityOf`. Appended
        // LAST + `@Optional()`: unbound reads closed, exactly the previous answer.
        @Optional()
        @Inject(APPS_TIER_POLICY)
        private readonly tier?: AppsTierPolicy,
    ) {}

    // ── the requests (T42/T43) ────────────────────────────────────────────────

    /**
     * Ask for a (re-)classification. Runs in-process (a handful of reads and one
     * write) and never throws: a licence request must not fail a hand-off or a sync.
     */
    async request(workId: string, reason?: string): Promise<void> {
        try {
            await this.evaluate(workId, reason);
        } catch (error) {
            this.logger.warn(
                `Licence evaluation for work ${workId} (${reason ?? 'initial'}) failed (${errorText(error)}).`,
            );
        }
    }

    /** One classification: read, classify, clear a stale attestation, write, record. */
    async evaluate(workId: string, reason?: string): Promise<AppLicenseEvaluation | null> {
        const states = this.states();
        if (!states) {
            this.logger.warn(
                `Licence evaluation for work ${workId}: no App spec state repository in this graph.`,
            );
            return null;
        }
        const state = await states.findByWorkId(workId);
        if (!state) {
            return null;
        }
        const coordinates = await this.coordinatesOf(workId);

        const declared = firstNonEmpty(
            (state.effectiveSpec as { license?: { spdx?: string } } | null | undefined)?.license
                ?.spdx,
        );
        const commitSha = firstNonEmpty(state.effectiveCommitSha, state.headCommitSha);
        // T41 — the repository scan (tree, root manifests, mixed directories). It runs
        // even when the spec declares a licence: a declared MIT over an `ee/` directory is
        // still a mixed repository, and mixed is at least amber (ACC-03-32).
        const detection = await this.scanRepository(
            coordinates,
            commitSha ?? firstNonEmpty(state.trackedBranch) ?? 'main',
        );
        let spdx: string | null = declared;
        let source: 'detected' | 'blueprint' = 'blueprint';
        if (!spdx) {
            source = 'detected';
            spdx = detection ? detection.spdx : await this.detectSpdx(coordinates);
        }
        const licenseClass = applyMixed(classifyLicenseExpression(spdx), detection?.mixed === true);
        const obligations = obligationsFor(spdx);

        const changed =
            (state.licenseSpdx ?? null) !== (spdx ?? null) ||
            (state.licenseClass ?? null) !== licenseClass;
        const nextState = { ...state, licenseSpdx: spdx, licenseClass } as WorkAppSpecState;
        const attestationCleared = Boolean(state.attestation) && !attestationIsValid(nextState);

        const seq = await states.nextLicenseSeq(workId);
        if (seq === null) {
            return null;
        }
        await states.writeLicense(workId, seq, {
            licenseSpdx: spdx,
            licenseClass,
            licenseSource: source,
            licenseObligations: obligations,
            licenseCommitSha: commitSha,
            ...(detection
                ? {
                      licenseMixed: detection.mixed,
                      licenseScanIncomplete: detection.scanIncomplete,
                      licenseEvidence: {
                          files: detection.evidence.files,
                          mixedPaths: detection.evidence.mixedPaths,
                      },
                  }
                : { licenseScanIncomplete: true }),
            licenseRegistryHash: LICENSE_REGISTRY_SNAPSHOT_SOURCE.commitSha,
            licenseRegistrySource: 'snapshot',
            ...(attestationCleared ? { attestation: null } : {}),
            // Display cache only (plan §2.6:348); eligibility recomputes it per call.
            sourceOfferRequired: obligations.includes(NETWORK_SOURCE_OFFER),
        });

        const userId = coordinates?.userId;
        const firstClassification = state.licenseClass === null || state.licenseClass === undefined;
        await this.record(workId, userId, {
            action: firstClassification
                ? APP_LICENSE_ACTIVITY_EVENTS.classified
                : changed
                  ? APP_LICENSE_ACTIVITY_EVENTS.changed
                  : APP_LICENSE_ACTIVITY_EVENTS.classified,
            summary: `License classified ${licenseClass}${spdx ? ` (${spdx})` : ''}`,
            details: {
                spdx,
                licenseClass,
                source,
                reason: reason ?? 'initial',
                attestationCleared,
            },
        });
        if (
            licenseClass !== 'green' &&
            !attestationIsValid({
                ...nextState,
                attestation: attestationCleared ? null : state.attestation,
            })
        ) {
            await this.record(workId, userId, {
                action: APP_LICENSE_ACTIVITY_EVENTS.attestationRequired,
                summary:
                    "The license requires the owner's attestation before it can run on your cluster",
                details: { spdx, licenseClass },
            });
        }

        return {
            workId,
            spdx,
            licenseClass,
            source,
            obligations,
            changed,
            attestationCleared,
            commitSha,
        };
    }

    // ── eligibility (APW-06's gate) ───────────────────────────────────────────

    async getHostingEligibility(
        workId: string,
        opts?: { commitSha?: string },
    ): Promise<HostingEligibility | null> {
        const states = this.states();
        if (!states) return null;
        let state = await states.findByWorkId(workId);
        if (!state) return null;
        const declaredNow = firstNonEmpty(
            (state.effectiveSpec as { license?: { spdx?: string } } | null | undefined)?.license
                ?.spdx,
        );
        if (!state.licenseClass || (declaredNow && declaredNow !== state.licenseSpdx)) {
            // Never classified yet, or the effective App spec now declares a licence the
            // stored classification did not use (the first classification ran before the
            // spec evaluation landed): classify now rather than judge a stale row.
            await this.evaluate(workId, 'eligibility');
            state = await states.findByWorkId(workId);
            if (!state?.licenseClass) return null;
        }
        const coordinates = await this.coordinatesOf(workId);
        const upstream = await this.safe(() => this.upstreamStates()?.findByWorkId(workId));
        const aheadBy = typeof upstream?.aheadBy === 'number' ? upstream.aheadBy : null;
        const isPublic = coordinates ? await this.isPublic(coordinates) : false;
        const spec = state.effectiveSpec as { license?: { sourceOfferUrl?: string } } | null;

        return hostingEligibilityOf({
            licenseClass: state.licenseClass as LicenseClass,
            attested: attestationIsValid(state),
            obligations: state.licenseObligations ?? obligationsFor(state.licenseSpdx ?? null),
            relation: coordinates?.relation ?? 'link',
            aheadBy,
            isPublic,
            owner: coordinates?.owner ?? '',
            repo: coordinates?.repo ?? '',
            commitSha: opts?.commitSha ?? null,
            sourceOfferUrl: firstNonEmpty(spec?.license?.sourceOfferUrl),
            registrySnapshot: (state.licenseRegistrySource ?? 'snapshot') === 'snapshot',
            verified: false,
            ...this.tierFacts(),
        });
    }

    /** The tier's scope and switch, read per call; a throwing or absent policy reads closed. */
    private tierFacts(): { managedScope?: 'any' | 'verified-blueprints'; tierOpen: boolean } {
        const tier = this.tier;
        if (!tier || typeof tier.isOpen !== 'function') return { tierOpen: false };
        try {
            const open = tier.isOpen() === true;
            return {
                tierOpen: open,
                ...(open && typeof tier.managedScope === 'function'
                    ? { managedScope: tier.managedScope() }
                    : {}),
            };
        } catch {
            return { tierOpen: false };
        }
    }

    // ── attestation (T44) ─────────────────────────────────────────────────────

    /**
     * The owner attests the current classification. Owner-only (`403 ownerOnly`, a
     * manager included); `422 attestationNotRequired` for green or an already valid
     * record; `409 licenseChanged` when the classification moved under the caller.
     */
    async attest(
        workId: string,
        userId: string,
        expected?: { spdx?: string | null; class?: string | null },
    ): Promise<LicenseAttestation> {
        const states = this.states();
        const work = this.works ? await this.works.findById(workId) : null;
        if (!work || !states) {
            throw new NotFoundException({ code: APP_LICENSE_ATTEST_CODES.notFound });
        }
        if (work.userId !== userId) {
            throw new ForbiddenException({
                code: APP_LICENSE_ATTEST_CODES.ownerOnly,
                message: "Only the App Work's owner can attest its license.",
            });
        }
        let state = await states.findByWorkId(workId);
        if (state && !state.licenseClass) {
            await this.evaluate(workId, 'attest');
            state = await states.findByWorkId(workId);
        }
        if (!state) {
            throw new NotFoundException({ code: APP_LICENSE_ATTEST_CODES.notFound });
        }
        const licenseClass = (state.licenseClass ?? 'unknown') as LicenseClass;
        const spdx = state.licenseSpdx ?? null;
        if (
            expected &&
            ((expected.spdx !== undefined && (expected.spdx ?? null) !== spdx) ||
                (expected.class !== undefined && expected.class !== licenseClass))
        ) {
            throw new ConflictException({
                code: APP_LICENSE_ATTEST_CODES.licenseChanged,
                message: 'The license classification changed; review it and attest again.',
            });
        }
        if (licenseClass === 'green' || attestationIsValid(state)) {
            throw new UnprocessableEntityException({
                code: APP_LICENSE_ATTEST_CODES.attestationNotRequired,
                message: 'This license does not need an attestation.',
            });
        }
        const text = attestationTextFor(spdx);
        const attestation: LicenseAttestation = {
            userId,
            attestedAt: new Date().toISOString(),
            spdx: spdx ?? '',
            class: licenseClass,
            textId: text?.textId ?? 'unknown-license-v1',
            textSha256: createHash('sha256')
                .update(text?.text ?? '', 'utf8')
                .digest('hex'),
            commitSha: state.licenseCommitSha ?? '',
        };
        const written = await states.writeAttestation(workId, attestation, {
            licenseSpdx: spdx,
            licenseClass: state.licenseClass ?? null,
        });
        if (!written) {
            throw new ConflictException({
                code: APP_LICENSE_ATTEST_CODES.licenseChanged,
                message: 'The license classification changed; review it and attest again.',
            });
        }
        await this.record(workId, userId, {
            action: APP_LICENSE_ACTIVITY_EVENTS.attested,
            summary: `The owner attested the ${licenseClass} license${spdx ? ` (${spdx})` : ''}`,
            details: { spdx, licenseClass, textId: attestation.textId },
        });
        return attestation;
    }

    /** The attestation text the owner is asked to confirm (for the dialog / DTO). */
    attestationText(spdx: string | null): LicenseRegistryAttestation | null {
        return attestationTextFor(spdx);
    }

    // ── FR-37 (APW-02's sync) ─────────────────────────────────────────────────

    /**
     * Would moving to upstream's head make the licence class WORSE? Reads upstream's
     * provider-detected licence; `null` when nothing can be read (the sync then takes
     * the pull-request path, its documented safe answer).
     */
    async previewUpstream(
        workId: string,
        owner: string,
        repo: string,
        sha: string,
    ): Promise<{ worse: boolean; spdx: string | null; licenseClass: LicenseClass } | null> {
        void sha;
        const coordinates = await this.coordinatesOf(workId);
        if (!this.git || !coordinates) return null;
        const repository = await this.safe(() =>
            this.git!.getRepository(owner, repo, {
                userId: coordinates.userId,
                providerId: coordinates.providerId,
                workId,
            }),
        );
        if (!repository) return null;
        const spdx = detectedLicenseSpdx(
            (repository as { licenseSpdx?: string | null }).licenseSpdx ?? null,
        );
        const upstreamClass = classifyLicenseExpression(spdx);
        const states = this.states();
        const state = states ? await this.safe(() => states.findByWorkId(workId)) : null;
        const currentClass = (state?.licenseClass ?? 'unknown') as LicenseClass;
        return {
            worse: LICENSE_CLASS_RANK[upstreamClass] > LICENSE_CLASS_RANK[currentClass],
            spdx,
            licenseClass: upstreamClass,
        };
    }

    // ── internals ─────────────────────────────────────────────────────────────

    private states(): WorkAppSpecStateRepository | undefined {
        if (!this.moduleRef) return undefined;
        try {
            return getOptionalProvider<WorkAppSpecStateRepository>(
                this.moduleRef,
                WorkAppSpecStateRepository,
            );
        } catch {
            return undefined;
        }
    }

    /** APW-02's state row (for `aheadBy`), provided by the App Works module. */
    private upstreamStates(): WorkUpstreamStateRepository | undefined {
        if (!this.moduleRef) return undefined;
        try {
            return getOptionalProvider<WorkUpstreamStateRepository>(
                this.moduleRef,
                WorkUpstreamStateRepository,
            );
        } catch {
            return undefined;
        }
    }

    private async coordinatesOf(workId: string): Promise<WorkCoordinates | null> {
        const work = this.works ? await this.safe(() => this.works!.findById(workId)) : null;
        if (!work) return null;
        const record = (work.sourceRepository ?? {}) as {
            owner?: string;
            repo?: string;
            type?: string;
            relatedRepositories?: { website?: { owner?: string; repo?: string } };
        };
        const owner =
            firstNonEmpty(record.relatedRepositories?.website?.owner, record.owner, work.owner) ??
            '';
        const repo =
            firstNonEmpty(record.relatedRepositories?.website?.repo, record.repo, work.slug) ?? '';
        const relation = relationOf(record as unknown as AppSourceRecord);
        return {
            workId,
            userId: work.userId,
            owner,
            repo,
            relation,
            providerId: firstNonEmpty(work.gitProvider) ?? 'github',
        };
    }

    /** T41's scan of the Work Repository at `ref`; `null` when it cannot run (no facade). */
    private async scanRepository(
        coordinates: WorkCoordinates | null,
        ref: string,
    ): Promise<LicenseDetection | null> {
        if (!this.git || !coordinates?.owner || !coordinates.repo) return null;
        if (typeof (this.git as Partial<LicenseDetectGit>).getRepositoryTree !== 'function') {
            return null;
        }
        try {
            return await detectRepositoryLicense({
                git: this.git,
                owner: coordinates.owner,
                repo: coordinates.repo,
                ref,
                options: {
                    userId: coordinates.userId,
                    providerId: coordinates.providerId,
                    workId: coordinates.workId,
                },
            });
        } catch (error) {
            this.logger.warn(
                `Licence scan of ${coordinates.owner}/${coordinates.repo}@${ref} failed (${errorText(error)}); root-only.`,
            );
            return null;
        }
    }

    // ── T43 — the triggers ────────────────────────────────────────────────────

    /**
     * T43 (first half) — re-classify after the App spec's effective commit changes, so
     * a licence the spec declares (or a repository change under it) reaches the row
     * without waiting for the next deploy's freshness check. Listens for APW-03's own
     * `app.spec.applied` event; never throws.
     */
    @OnEvent(AppSpecAppliedEvent.EVENT_NAME, { async: true, suppressErrors: true })
    async onSpecApplied(event: { workId?: string } | null | undefined): Promise<void> {
        const workId = firstNonEmpty(event?.workId);
        if (workId) {
            await this.request(workId, 'spec_changed');
        }
    }

    /**
     * T43 (second half) — the registry-change fan-out: re-classify at most `limit` (≤ 500)
     * App Works classified against a different registry than the one in force, oldest
     * first; the next run continues where this one stopped (ACC-03-22).
     */
    async refreshStaleRegistry(limit = LICENSE_REGISTRY_FANOUT_MAX): Promise<{
        scanned: number;
        evaluated: number;
    }> {
        const states = this.states();
        if (!states) return { scanned: 0, evaluated: 0 };
        const stale = await states.findStaleRegistry(
            LICENSE_REGISTRY_SNAPSHOT_SOURCE.commitSha,
            Math.min(Math.max(0, Math.floor(limit)), LICENSE_REGISTRY_FANOUT_MAX),
        );
        let evaluated = 0;
        for (const row of stale) {
            try {
                if (await this.evaluate(row.workId, 'registry_changed')) evaluated += 1;
            } catch (error) {
                this.logger.warn(
                    `Registry fan-out: re-classifying work ${row.workId} failed (${errorText(error)}).`,
                );
            }
        }
        return { scanned: stale.length, evaluated };
    }

    private async detectSpdx(coordinates: WorkCoordinates | null): Promise<string | null> {
        if (!this.git || !coordinates?.owner || !coordinates.repo) return null;
        const repository = await this.safe(() =>
            this.git!.getRepository(coordinates.owner, coordinates.repo, {
                userId: coordinates.userId,
                providerId: coordinates.providerId,
                workId: coordinates.workId,
            }),
        );
        return detectedLicenseSpdx(
            (repository as { licenseSpdx?: string | null } | null)?.licenseSpdx ?? null,
        );
    }

    private async isPublic(coordinates: WorkCoordinates): Promise<boolean> {
        if (!this.git || !coordinates.owner || !coordinates.repo) return false;
        const repository = (await this.safe(() =>
            this.git!.getRepository(coordinates.owner, coordinates.repo, {
                userId: coordinates.userId,
                providerId: coordinates.providerId,
                workId: coordinates.workId,
            }),
        )) as { visibility?: string; isPrivate?: boolean } | null;
        if (!repository) return false;
        if (repository.visibility) return repository.visibility === 'public';
        return repository.isPrivate === false;
    }

    private async record(
        workId: string,
        userId: string | undefined,
        entry: { action: string; summary: string; details: Record<string, unknown> },
    ): Promise<void> {
        if (!this.activity || !userId) return;
        try {
            await this.activity.log({
                userId,
                workId,
                actionType: APP_LICENSE_ACTIVITY_ACTION_TYPE as unknown as ActivityActionType,
                action: entry.action,
                status: ActivityStatus.COMPLETED,
                summary: entry.summary,
                details: entry.details,
            } as never);
        } catch (error) {
            this.logger.warn(
                `Recording the licence Activity row for work ${workId} failed (${errorText(error)}).`,
            );
        }
    }

    private async safe<T>(read: () => Promise<T> | T | undefined): Promise<T | null> {
        try {
            const value = await read();
            return value ?? null;
        } catch {
            return null;
        }
    }
}
