import { createHash, randomUUID } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { isLocalHost, type KeySet } from '@ever-co/connect-sdk';
import { serializeOnSingleConnection } from '@ever-works/agent/database';
import {
    EverConnectLink,
    EverConnectProvisionRecord,
    ExternalIdentity,
    MissionType,
    User,
    type EverConnectProvisionStaffing,
    type EverConnectProvisionSteps,
} from '@ever-works/agent/entities';
import { IdentityProviderFacadeService } from '@ever-works/agent/facades';
import { MissionsService } from '@ever-works/agent/missions';
import { WorkLifecycleService } from '@ever-works/agent/services';
import { isUniqueConstraintError } from '@ever-works/agent/utils';
import { EverIdSealError, EverIdSealService } from '../../auth/services/ever-id-seal.service';
import {
    CompanyImportIncompleteError,
    CompanyImportService,
} from '../../organizations/company-import.service';
import { OrgTemplateCatalogService } from '../../organizations/org-template-catalog.service';
import { OrganizationService } from '../../organizations/organization.service';
import { TenantBootstrapService } from '../../scope/tenant-bootstrap.service';
import { ScopeContextService } from '../../scope/scope-context.service';
import { UsernameAllocatorService } from '../../users/services/username-allocator.service';
import { EVER_CONNECT_CONFIG, type EverConnectConfig } from '../ever-connect.config';
import { EverConnectService } from '../ever-connect.service';
import type { ProvisionCompanyDto } from './dto/provision.dto';
import { EverConnectProvisionCallback } from './ever-connect-provision-callback.service';
import {
    ClaimLostError,
    EverConnectProvisionStore,
    isFinished,
} from './ever-connect-provision.store';
import {
    IntentRefusedError,
    verifyProvisionIntent,
    type ProvisionIntentClaims,
} from './provision-intent.verifier';
import { isProvisionStaffingEnabled, provisionCapabilities } from './provision.switches';

/**
 * How long one attempt holds a creation before another may take it over (a stopped
 * process); renewed after each step, so only an attempt that stopped loses it.
 */
export const CREATION_CLAIM_MS = 5 * 60_000;

/** How long a second request for a running creation waits for its end before answering 409. */
export const CREATION_WAIT_MS = 10_000;

/** How often that request looks again. */
const CREATION_POLL_MS = 250;

/** How long the answer to the person waits for Ever Platform's. */
const REPORT_WAIT_MS = 10_000;

/** How many times the core is re-run when a slug race lost its transaction. */
const CORE_ATTEMPTS = 4;

const SLUG_SHAPE = /^[a-z0-9-]{1,64}$/;

/** A refusal: the platform's error body, a code and fixed words, no value of anyone's. */
function problem(status: number, code: string, message: string, extra?: object): HttpException {
    return new HttpException({ status: 'error', code, message, ...extra }, status);
}

const notFound = () =>
    problem(HttpStatus.NOT_FOUND, 'intent_not_found', 'This request is not known here.');
const expired = () =>
    problem(HttpStatus.GONE, 'intent_expired', 'This request has expired; start again from Ever.');
const mismatch = () =>
    problem(
        HttpStatus.FORBIDDEN,
        'intent_subject_mismatch',
        'Sign in with the same Ever ID you used on app.ever.co.',
    );
const consumed = (organizationSlug?: string | null) =>
    problem(HttpStatus.CONFLICT, 'intent_consumed', 'This request was already used.', {
        ...(organizationSlug ? { organizationSlug } : {}),
    });

/** What the landing and confirmation pages show of a request. */
export interface ProvisionDisplay {
    handle: string;
    displayName: string;
    legalName: string | null;
    country: string | null;
    staffTemplateSlug: string | null;
    firstMission: { title: string; goal: string } | null;
}

/** `POST /api/ever-connect/provision`. */
export interface ProvisionIntakeResponse {
    provisionTxn: string;
    display: ProvisionDisplay;
    capabilities: {
        provisionHandoff: boolean;
        provisionCompany: boolean;
        everIdAvailable: boolean;
    };
    expiresAt: string;
}

/** `POST /api/ever-connect/provision/summary`. */
export interface ProvisionSummaryResponse {
    display: ProvisionDisplay;
    capabilities: { provisionHandoff: boolean; provisionCompany: boolean };
    /** The company this step already created, when there is one. */
    existing: { organizationId: string; organizationSlug: string } | null;
    returnTo: string;
    expiresAt: string;
}

/** `POST /api/ever-connect/provision/company`. */
export interface ProvisionCompanyResponse {
    status: 'created' | 'partial';
    organizationId: string;
    organizationSlug: string;
    everHandle: string;
    slugEqualsHandle: boolean;
    companyWorkId: string;
    tenantId: string;
    userId: string;
    staffing: EverConnectProvisionStaffing;
    mission: { status: string; missionId?: string; code?: string };
    link: { status: 'sent' | 'pending'; platformLinkId: string | null };
    partial: boolean;
    /** The Ever page the person goes back to. */
    returnTo: string;
}

/** The request behind a verified handle, bound to the signed-in person. */
interface Resolved {
    jti: string;
    claims: ProvisionIntentClaims;
}

/**
 * Creating a company a person asked for in Ever (`EVER_CONNECT_PROVISIONING_ENABLED`):
 *
 * 1. {@link intake}: Ever Platform's signed request is verified and kept by its
 *    `jti`; the browser holds a sealed handle, never the request. Nothing else is
 *    created.
 * 2. The person signs in with Ever ID here; the session's connected identity must
 *    be the person the request names ({@link resolve}).
 * 3. {@link createCompany}, after one confirmation: the Company Work, the
 *    Organization (the person's own, in their Tenant) and its link commit together;
 *    then the Work is registered, starter staff (agents stay paused) and the first
 *    Mission are made, and Ever Platform is told.
 *
 * What makes it repeat-safe: the signed `idempotency_key` is the key of the
 * creation, and Ever Platform makes a new `jti` for each attempt of a step under
 * it. So the same key answers the company already made and never creates a second
 * one; a stopped or failed creation is finished by its retry, whether that carries
 * the same request or a new one (the report then names the new one); the same `jti`
 * with another browser key gets `409 intent_consumed` only once the company exists;
 * and one Ever organization never gets two companies. One attempt runs at a time
 * (a claim on the record, renewed after each step and checked again in the core's
 * transaction).
 */
@Injectable()
export class EverConnectProvisionService {
    private readonly logger = new Logger('EverConnectProvision');
    private keySet: { key: string; set: KeySet } | null = null;

    constructor(
        private readonly store: EverConnectProvisionStore,
        private readonly connection: EverConnectService,
        private readonly callback: EverConnectProvisionCallback,
        private readonly seal: EverIdSealService,
        private readonly identity: IdentityProviderFacadeService,
        private readonly organizations: OrganizationService,
        private readonly tenants: TenantBootstrapService,
        private readonly works: WorkLifecycleService,
        private readonly imports: CompanyImportService,
        private readonly templates: OrgTemplateCatalogService,
        private readonly missions: MissionsService,
        private readonly scope: ScopeContextService,
        private readonly usernames: UsernameAllocatorService,
        @Inject(EVER_CONNECT_CONFIG) private readonly config: EverConnectConfig,
    ) {}

    // ── Intake ───────────────────────────────────────────────────────────────

    /** Verify a request and keep it. Nothing else is created. */
    async intake(jws: unknown): Promise<ProvisionIntakeResponse> {
        const { instanceId } = await this.connected();
        const claims = await this.verify(jws, instanceId);

        const record = await this.store.byJti(claims.jti);
        if (record && (isFinished(record) || record.status === 'refused')) {
            throw consumed(record.organizationSlug);
        }
        const saved = await this.store.saveIntent({
            jti: claims.jti,
            idempotencyKey: claims.idempotency_key,
            claims: JSON.stringify(claims),
            expiresAt: new Date(claims.exp * 1000),
        });
        if (!saved) throw consumed();
        this.logger.log(`ever_connect.provision.received ${claims.jti}`);

        return {
            provisionTxn: this.seal.seal('provision', { jti: claims.jti }),
            display: displayOf(claims),
            capabilities: {
                ...provisionCapabilities(),
                everIdAvailable: await this.identity.isAvailable().catch(() => false),
            },
            expiresAt: new Date(claims.exp * 1000).toISOString(),
        };
    }

    private async verify(jws: unknown, instanceId: string): Promise<ProvisionIntentClaims> {
        const client = await this.connection.client();
        if (!client) throw notConnected();
        try {
            return await verifyProvisionIntent(
                jws,
                {
                    keys: () => this.keys(instanceId),
                    refresh: () => this.keys(instanceId, true),
                },
                {
                    issuer: client.issuer,
                    apiUrl: this.config.platformApiUrl,
                    instanceId,
                    now: Math.floor(Date.now() / 1000),
                    localPlatform: this.localPlatform(),
                },
            );
        } catch (error) {
            if (error instanceof IntentRefusedError) {
                this.logger.log(`A provisioning request was refused (${error.reason}).`);
                throw error;
            }
            this.logger.warn('A provisioning request could not be verified: no key set.');
            throw problem(
                HttpStatus.SERVICE_UNAVAILABLE,
                'connector_unavailable',
                'Ever Platform cannot be reached right now. Try again in a minute.',
            );
        }
    }

    /** Ever Platform's root-verified key set, fetched once and again when it is due. */
    private async keys(instanceId: string, refresh = false): Promise<KeySet> {
        const client = await this.connection.client();
        if (!client) throw notConnected();
        const current = this.keySet?.key === instanceId ? this.keySet.set : undefined;
        if (current && !refresh && !current.needsRefresh()) return current;
        try {
            const update = await client.keys.refresh(current);
            if (update.error && !current) throw update.error;
            if (update.replaced || !current) {
                this.keySet = { key: instanceId, set: update.keySet };
            }
            return this.keySet?.set as KeySet;
        } catch (error) {
            // The current set stays in use until a newer manifest verifies.
            if (current) return current;
            throw error;
        }
    }

    private localPlatform(): boolean {
        try {
            return isLocalHost(new URL(this.config.platformApiUrl).hostname);
        } catch {
            return false;
        }
    }

    // ── Reading a request ────────────────────────────────────────────────────

    /** The request behind a handle, for the person it names. */
    private async resolve(userId: string, provisionTxn: unknown): Promise<Resolved> {
        let jti: string;
        try {
            jti = this.seal.unseal<{ jti: string }>('provision', provisionTxn).jti;
        } catch (error) {
            if (error instanceof EverIdSealError) throw notFound();
            throw error;
        }
        return this.resolveJti(userId, jti);
    }

    private async resolveJti(userId: string, jti: string): Promise<Resolved> {
        const intent = await this.store.intent(jti);
        if (!intent) throw notFound();
        if (Date.now() >= new Date(intent.expiresAt).getTime()) throw expired();
        const claims = JSON.parse(intent.claims) as ProvisionIntentClaims;
        await this.assertSubject(userId, claims);
        return { jti, claims };
    }

    /** The session's connected identity must be the person the request names, at Ever ID. */
    private async assertSubject(userId: string, claims: ProvisionIntentClaims): Promise<void> {
        let issuer: string;
        try {
            issuer = (await this.identity.getPublicConfig()).issuer;
        } catch {
            throw problem(
                HttpStatus.CONFLICT,
                'ever_id_unavailable',
                'Signing in with Ever ID is not available right now.',
            );
        }
        const identity = await this.store.dataSource
            .getRepository(ExternalIdentity)
            .findOne({ where: { userId, issuer } });
        if (identity?.subject !== claims.person.ever_id_sub) throw mismatch();
    }

    /** What the confirmation page shows (no side effect). */
    async summary(userId: string, provisionTxn: unknown): Promise<ProvisionSummaryResponse> {
        const { claims } = await this.resolve(userId, provisionTxn);
        const record = await this.store.byKey(claims.idempotency_key);
        return {
            display: displayOf(claims),
            capabilities: provisionCapabilities(),
            existing:
                record && isFinished(record) && record.organizationId && record.organizationSlug
                    ? {
                          organizationId: record.organizationId,
                          organizationSlug: record.organizationSlug,
                      }
                    : null,
            returnTo: claims.return_to,
            expiresAt: new Date(claims.exp * 1000).toISOString(),
        };
    }

    /** Where a request stands: status and slugs only. */
    async status(userId: string, jti: string) {
        await this.resolveJti(userId, jti);
        const record = await this.store.byJti(jti);
        return {
            status: record?.status ?? 'pending',
            organizationSlug: record?.organizationSlug ?? null,
            link: record?.callbackStatus === 'sent' ? 'sent' : 'pending',
        };
    }

    // ── The person declines ──────────────────────────────────────────────────

    /** Nothing is created; Ever Platform is told, so it can offer to try again. */
    async reject(userId: string, jti: string): Promise<{ status: 'refused'; returnTo: string }> {
        const { claims } = await this.resolveJti(userId, jti);
        const record = await this.store.refuse({
            creationKey: claims.idempotency_key,
            jti,
            iat: claims.iat,
            everOrgId: claims.org.id,
            handle: claims.org.handle,
            userId,
        });
        if (!record) throw consumed();
        await this.store.markIntent(jti, 'refused', JSON.stringify(withoutMission(claims)));
        this.logger.log(`ever_connect.provision.rejected ${jti}`);
        await this.waitForReport(record.creationKey);
        return { status: 'refused', returnTo: claims.return_to };
    }

    // ── The person confirms ──────────────────────────────────────────────────

    async createCompany(
        userId: string,
        idempotencyKey: unknown,
        body: ProvisionCompanyDto,
    ): Promise<{ created: boolean; answer: ProvisionCompanyResponse }> {
        if (
            typeof idempotencyKey !== 'string' ||
            idempotencyKey.length < 1 ||
            idempotencyKey.length > 128
        ) {
            throw problem(
                HttpStatus.BAD_REQUEST,
                'validation',
                'The Idempotency-Key header is required (1 to 128 characters).',
            );
        }
        const { jti, claims } = await this.resolve(userId, body.provisionTxn);
        await this.connected();
        const creationKey = claims.idempotency_key;
        const bodyHash = hashOf(body);

        const known = await this.store.byKey(creationKey);
        if (known) {
            if (
                known.intentJti === jti &&
                known.idempotencyKey === idempotencyKey &&
                known.bodyHash !== bodyHash
            ) {
                throw problem(
                    HttpStatus.CONFLICT,
                    'idempotency_key_reused_with_different_body',
                    'This confirmation was sent before with other values.',
                );
            }
            if (isFinished(known)) {
                return this.answerFinished(known, claims, jti, idempotencyKey);
            }
        }

        const plan = await this.planOf(claims, body);
        const tenant = await this.tenants.ensureTenant(userId);
        await this.assertFree(claims, tenant.id, known);

        const holder = randomUUID();
        const claim = await this.store.claim(
            {
                creationKey,
                jti,
                iat: claims.iat,
                everOrgId: claims.org.id,
                handle: claims.org.handle,
                userId,
                idempotencyKey,
                bodyHash,
            },
            holder,
            this.claimEnd(),
        );
        switch (claim.outcome) {
            case 'replayed':
                throw consumed();
            case 'org_linked':
                throw orgLinked();
            case 'finished':
                return this.answerFinished(claim.record, claims, jti, idempotencyKey);
            case 'busy':
                return this.waitForCreation(creationKey, claims, jti, idempotencyKey);
        }

        let record = claim.record;
        if (record.userId && record.userId !== userId) throw mismatch();
        try {
            record = await this.runSteps(record, holder, userId, claims, plan);
        } catch (error) {
            if (error instanceof ClaimLostError) {
                return this.waitForCreation(creationKey, claims, jti, idempotencyKey);
            }
            const code = errorCode(error);
            await this.store.fail(record.id, holder, code).catch(() => undefined);
            this.logger.warn(`ever_connect.provision.failed ${jti} (${code})`);
            if (error instanceof HttpException && error.getStatus() < 500) throw error;
            throw problem(
                HttpStatus.INTERNAL_SERVER_ERROR,
                'provisioning_failed',
                'The company could not be created; try again.',
            );
        }

        await this.store
            .markIntent(jti, 'accepted', JSON.stringify(withoutMission(claims)))
            .catch(() => undefined);
        this.logger.log(`ever_connect.provision.${record.status} ${jti}`);
        await this.waitForReport(creationKey);
        const finished = (await this.store.byKey(creationKey)) as EverConnectProvisionRecord;
        return { created: true, answer: answerOf(finished, claims) };
    }

    /** Refuse what cannot be created: another company of this Ever organization or tenant. */
    private async assertFree(
        claims: ProvisionIntentClaims,
        tenantId: string,
        known: EverConnectProvisionRecord | null,
    ): Promise<void> {
        const ours = known?.organizationId ?? null;
        const everOrg = await this.store.activeLinkOfEverOrg(claims.org.id);
        if (everOrg && everOrg.organizationId !== ours) throw orgLinked();
        const inTenant = await this.store.activeLinkOfTenant(tenantId);
        if (inTenant && inTenant.organizationId !== ours) {
            throw problem(
                HttpStatus.CONFLICT,
                'tenant_already_linked',
                'Your account already has a company linked to Ever.',
            );
        }
    }

    /** What this confirmation asks for, checked before anything is created. */
    private async planOf(
        claims: ProvisionIntentClaims,
        body: ProvisionCompanyDto,
    ): Promise<CompanyPlan> {
        const slug = body.slug ?? this.usernames.normalize(claims.org.handle);
        if (!SLUG_SHAPE.test(slug)) {
            throw problem(
                HttpStatus.UNPROCESSABLE_ENTITY,
                'slug_invalid',
                'A slug is 1 to 64 lower-case letters, digits or hyphens.',
            );
        }
        const name = (body.name ?? claims.org.display_name).trim();
        const legalName = (body.legalName ?? claims.org.legal_name ?? name).trim();
        if (!name || name.length > 200 || !legalName || legalName.length > 200) {
            throw problem(HttpStatus.BAD_REQUEST, 'validation', 'A name is 1 to 200 characters.');
        }
        const staffing = isProvisionStaffingEnabled();
        const template =
            body.staffTemplateSlug === undefined
                ? (claims.features.staff_template ?? null)
                : body.staffTemplateSlug;
        if (staffing && template && !(await this.templates.getPackage(template))) {
            throw problem(
                HttpStatus.NOT_FOUND,
                'template_not_found',
                'That staffing template is not available.',
            );
        }
        const firstMission =
            body.firstMission === undefined
                ? (claims.features.first_mission ?? null)
                : body.firstMission;
        return {
            name,
            legalName,
            countryCode: (body.countryCode ?? claims.org.country ?? null)?.toUpperCase() ?? null,
            slug,
            template,
            firstMission,
            staffing,
        };
    }

    private async runSteps(
        start: EverConnectProvisionRecord,
        holder: string,
        userId: string,
        claims: ProvisionIntentClaims,
        plan: CompanyPlan,
    ): Promise<EverConnectProvisionRecord> {
        let record = start;
        if (record.steps.cursor === 'none') {
            record = await this.runCore(record, holder, userId, claims, plan);
        }
        const steps: EverConnectProvisionSteps = { ...record.steps };
        if (steps.cursor === 'core_done') {
            await this.works.transitionStatus(record.companyWorkId as string, 'registered');
            steps.cursor = 'registered';
            await this.store.checkpoint(record.id, holder, { steps }, this.claimEnd());
        }

        if (steps.staffing?.status !== 'created' && steps.staffing?.status !== 'skipped') {
            steps.staffing = await this.staff(record, holder, userId, plan, steps);
            await this.store.checkpoint(record.id, holder, { steps }, this.claimEnd());
        }
        if (steps.mission?.status !== 'created' && steps.mission?.status !== 'skipped') {
            const { result, missionId } = await this.firstMission(
                record,
                holder,
                userId,
                plan,
                steps,
            );
            steps.mission = result;
            await this.store.checkpoint(
                record.id,
                holder,
                { steps, ...(missionId ? { missionId } : {}) },
                this.claimEnd(),
            );
        }

        steps.cursor = 'done';
        const partial = steps.staffing?.status === 'failed' || steps.mission?.status === 'failed';
        await this.store.finish(record.id, holder, partial ? 'partial' : 'created', steps);
        return (await this.store.byKey(record.creationKey)) as EverConnectProvisionRecord;
    }

    /**
     * The Company Work, the Organization and the link commit together with the
     * record's cursor. A failure leaves none of them. A slug another request took
     * loses the transaction, so the whole core runs again with the next free slug.
     */
    private async runCore(
        record: EverConnectProvisionRecord,
        holder: string,
        userId: string,
        claims: ProvisionIntentClaims,
        plan: CompanyPlan,
    ): Promise<EverConnectProvisionRecord> {
        const dataSource = this.store.dataSource;
        for (let attempt = 1; ; attempt++) {
            try {
                await serializeOnSingleConnection(dataSource.manager, () =>
                    dataSource.transaction(async (manager) => {
                        await this.store.assertClaim(manager, record.id, holder);
                        const work = await this.works.createCompanyWork(
                            { id: userId } as User,
                            {
                                name: plan.name,
                                slug: `${this.usernames.normalize(plan.name)}-${Date.now().toString(36)}`,
                                companyName: plan.legalName,
                                status: 'draft',
                            },
                            { manager },
                        );
                        const organization = await this.organizations.registerCompany(userId, {
                            name: plan.name,
                            legalName: plan.legalName,
                            countryCode: plan.countryCode,
                            slugOverride: plan.slug,
                            linkedWorkId: work.id,
                            registrationProvider: 'ever-platform',
                            manager,
                        });
                        await manager.getRepository(EverConnectLink).insert({
                            organizationId: organization.id,
                            tenantId: organization.tenantId as string,
                            everOrgId: claims.org.id,
                            handle: claims.org.handle,
                            createdVia: 'provisioning',
                            status: 'active',
                        });
                        await manager
                            .getRepository(EverConnectProvisionRecord)
                            .update({ id: record.id }, {
                                tenantId: organization.tenantId,
                                organizationId: organization.id,
                                organizationSlug: organization.slug,
                                companyWorkId: work.id,
                                steps: { cursor: 'core_done' },
                            } as object);
                    }),
                );
                break;
            } catch (error) {
                if (!isUniqueConstraintError(error) || attempt >= CORE_ATTEMPTS) throw error;
                this.logger.warn(
                    `The company core lost a race (attempt ${attempt}); running again.`,
                );
            }
        }
        await this.store.checkpoint(record.id, holder, {}, this.claimEnd());
        return (await this.store.byKey(record.creationKey)) as EverConnectProvisionRecord;
    }

    /** Starter staff in the Organization: agents paused, once per key, never fatal. */
    private async staff(
        record: EverConnectProvisionRecord,
        holder: string,
        userId: string,
        plan: CompanyPlan,
        steps: EverConnectProvisionSteps,
    ): Promise<EverConnectProvisionStaffing> {
        if (!plan.staffing) return { status: 'skipped', code: 'disabled' };
        if (!plan.template) return { status: 'skipped', code: 'not_chosen' };
        await this.store.checkpoint(
            record.id,
            holder,
            { steps: { ...steps, staffing: { status: 'running' } } },
            this.claimEnd(),
        );
        try {
            const report = await this.imports.importCompany(userId, {
                templateSlug: plan.template,
                organizationId: record.organizationId as string,
                importKey: record.creationKey,
            });
            return {
                status: 'created',
                templateSlug: plan.template,
                agents: report.created.agents,
                teams: report.created.teams,
                skills: report.created.skills,
                works: report.created.works,
                tasks: report.created.tasks,
            };
        } catch (error) {
            const code =
                error instanceof CompanyImportIncompleteError ? error.code : 'import_failed';
            this.logger.warn(`Starter staff not imported (${code}).`);
            return { status: 'failed', code };
        }
    }

    /** The first Mission in the Organization's scope, never fatal, never twice. */
    private async firstMission(
        record: EverConnectProvisionRecord,
        holder: string,
        userId: string,
        plan: CompanyPlan,
        steps: EverConnectProvisionSteps,
    ): Promise<{
        result: NonNullable<EverConnectProvisionSteps['mission']>;
        missionId?: string;
    }> {
        if (!plan.staffing) return { result: { status: 'skipped', code: 'disabled' } };
        if (!plan.firstMission) return { result: { status: 'skipped', code: 'not_chosen' } };
        // Started before and not finished: it may exist, so it is not made again.
        if (steps.mission?.status === 'running') {
            return { result: { status: 'failed', code: 'mission_incomplete' } };
        }
        await this.store.checkpoint(
            record.id,
            holder,
            { steps: { ...steps, mission: { status: 'running' } } },
            this.claimEnd(),
        );
        const firstMission = plan.firstMission;
        try {
            const scope = {
                tenantId: record.tenantId as string,
                organizationId: record.organizationId as string,
            };
            const mission = await this.scope.runWith(scope, () =>
                this.missions.create(
                    userId,
                    {
                        title: firstMission.title,
                        description: firstMission.goal,
                        type: MissionType.ONE_SHOT,
                    },
                    scope,
                ),
            );
            return { result: { status: 'created' }, missionId: mission.id };
        } catch {
            this.logger.warn('The first Mission was not created.');
            return { result: { status: 'failed', code: 'mission_failed' } };
        }
    }

    // ── Answers ──────────────────────────────────────────────────────────────

    /**
     * The answer for a company that exists: the browser's own retry gets it again; a
     * newer request means Ever Platform has not heard of it, so the report now names
     * that request and goes out now; anything else is a request already used.
     */
    private async answerFinished(
        record: EverConnectProvisionRecord,
        claims: ProvisionIntentClaims,
        jti: string,
        idempotencyKey: string,
    ): Promise<{ created: boolean; answer: ProvisionCompanyResponse }> {
        if (record.intentJti === jti) {
            if (record.idempotencyKey !== idempotencyKey) throw consumed(record.organizationSlug);
        } else if (claims.iat < record.intentIssuedAt) {
            throw consumed(record.organizationSlug);
        } else if (await this.store.reportUnder(record.id, jti, claims.iat)) {
            await this.waitForReport(record.creationKey);
        }
        const current = (await this.store.byKey(record.creationKey)) as EverConnectProvisionRecord;
        return { created: false, answer: answerOf(current, claims) };
    }

    /** A creation another attempt is running: wait briefly for its end. */
    private async waitForCreation(
        creationKey: string,
        claims: ProvisionIntentClaims,
        jti: string,
        idempotencyKey: string,
    ): Promise<{ created: boolean; answer: ProvisionCompanyResponse }> {
        const deadline = Date.now() + CREATION_WAIT_MS;
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, CREATION_POLL_MS));
            const record = await this.store.byKey(creationKey);
            if (record && isFinished(record)) {
                return this.answerFinished(record, claims, jti, idempotencyKey);
            }
            if (record?.status === 'failed') break;
        }
        throw problem(
            HttpStatus.CONFLICT,
            'provisioning_in_progress',
            'This company is being created; try again in a moment.',
        );
    }

    /** The answer waits a moment for Ever Platform's; the report goes on regardless. */
    private async waitForReport(creationKey: string): Promise<void> {
        await Promise.race([
            this.callback.sendNow(creationKey),
            new Promise((resolve) => setTimeout(resolve, REPORT_WAIT_MS).unref?.()),
        ]);
    }

    private claimEnd(): Date {
        return new Date(Date.now() + CREATION_CLAIM_MS);
    }

    /** The connection every route here needs. */
    private async connected(): Promise<{ instanceId: string }> {
        const row = await this.connection.connection();
        if (row.status !== 'active' || !row.platformInstanceId) throw notConnected();
        if (this.config.installSource !== 'cloud') {
            // A self-hosted installation accepts each request first; that step is not here yet.
            throw problem(
                HttpStatus.CONFLICT,
                'operator_accept_required',
                'This installation does not take requests from Ever Platform yet.',
            );
        }
        return { instanceId: row.platformInstanceId };
    }
}

/** What one confirmation asks for. */
interface CompanyPlan {
    name: string;
    legalName: string;
    countryCode: string | null;
    slug: string;
    template: string | null;
    firstMission: { title: string; goal: string } | null;
    staffing: boolean;
}

function notConnected(): HttpException {
    return problem(
        HttpStatus.CONFLICT,
        'not_connected',
        'This installation is not connected to Ever Platform.',
    );
}

function orgLinked(): HttpException {
    return problem(
        HttpStatus.CONFLICT,
        'organization_already_linked',
        'This Ever organization already has a company here.',
    );
}

function displayOf(claims: ProvisionIntentClaims): ProvisionDisplay {
    return {
        handle: claims.org.handle,
        displayName: claims.org.display_name,
        legalName: claims.org.legal_name ?? null,
        country: claims.org.country ?? null,
        staffTemplateSlug: claims.features.staff_template ?? null,
        firstMission: claims.features.first_mission ?? null,
    };
}

/** The claims without what the person wrote: it did its work once the company exists. */
function withoutMission(claims: ProvisionIntentClaims): ProvisionIntentClaims {
    const { first_mission: _firstMission, ...features } = claims.features;
    return { ...claims, features };
}

/** The confirmation's values, not the handle that travels with them. */
function hashOf(body: ProvisionCompanyDto): string {
    const { provisionTxn: _handle, ...values } = body;
    const canonical = Object.keys(values)
        .sort()
        .map((key) => [key, (values as Record<string, unknown>)[key] ?? null]);
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function answerOf(
    record: EverConnectProvisionRecord,
    claims: ProvisionIntentClaims,
): ProvisionCompanyResponse {
    const staffing = record.steps.staffing ?? { status: 'skipped' as const };
    const mission = record.steps.mission ?? { status: 'skipped' as const };
    const partial = record.status === 'partial';
    return {
        status: partial ? 'partial' : 'created',
        organizationId: record.organizationId as string,
        organizationSlug: record.organizationSlug as string,
        everHandle: record.handle,
        slugEqualsHandle: record.organizationSlug === record.handle,
        companyWorkId: record.companyWorkId as string,
        tenantId: record.tenantId as string,
        userId: record.userId as string,
        staffing,
        mission: { ...mission, ...(record.missionId ? { missionId: record.missionId } : {}) },
        link: {
            status: record.callbackStatus === 'sent' ? 'sent' : 'pending',
            platformLinkId: record.platformLinkId,
        },
        partial,
        returnTo: claims.return_to,
    };
}

/** A short, value-free name for an error. */
function errorCode(error: unknown): string {
    if (isUniqueConstraintError(error)) return 'unique_violation';
    if (error instanceof HttpException) {
        const body = error.getResponse() as { code?: unknown };
        if (typeof body?.code === 'string') return body.code;
        return `http_${error.getStatus()}`;
    }
    return error instanceof Error ? error.name : 'unknown';
}
