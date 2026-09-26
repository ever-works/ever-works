import {
    Body,
    CanActivate,
    Controller,
    HttpCode,
    HttpStatus,
    Injectable,
    NotFoundException,
    Post,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { config } from '@ever-works/agent/config';
import {
    DeploymentEnvironment,
    DeploymentTriggerSource,
    DomainEnvironment,
    Work,
    WorkCustomDomain,
    WorkDeployment,
} from '@ever-works/agent/entities';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope/scope-context.service';
import {
    E2eSeedWorkDto,
    type E2eSeedCustomDomainDto,
    type E2eSeedDeploymentDto,
} from './dto/e2e-seed.dto';

/**
 * APW-11 T33 — the non-production seed route of the PR lane (APW11-G07).
 *
 * Spec: `docs/specs/features/app-works/APW-11-app-launcher/spec.md` (ACC-11-52);
 * plan §9.3 (`plan.md:1010-1024`) is the normative section, §10.5's
 * `ACCEPTANCE E2E-12` row is the caller, and CONTRACTS R-40
 * (`CONTRACTS.md:83`) is the standing pattern this route is the second
 * instance of.
 *
 *   | Route                              | Auth    | Gate                                   | Success | Refused |
 *   | ---------------------------------- | ------- | -------------------------------------- | ------- | ------- |
 *   | `POST /api/e2e/app-launcher/seed`  | session | `NODE_ENV !== 'production'` **and** `E2E_APP_LAUNCHER_SEED === 'true'` | 201 | 404 / 401 |
 *
 * ## Why this route exists at all (APW11-G07)
 *
 * The PR lane's API runs on an in-memory sqlite database
 * (`.github/workflows/e2e.yml:271-272`), so the Playwright process cannot write
 * the rows a READY-deployed Work needs, and a `page.route` cannot stand in
 * either because the panel's data comes from the API process. T20's helper
 * (`apps/web/e2e/helpers/app-launcher-seed.ts`) therefore seeds **through the
 * API**, and this is the one door it uses.
 *
 * ## The two-variable gate, read production-first
 *
 * {@link isE2eAppLauncherSeedEnabled} has the shape of
 * `config.subscriptions.bypassSeatLimitsInE2E()`
 * (`packages/agent/src/config/index.ts:824-829`): the production check comes
 * first and returns before either variable's value is consulted, so a stray
 * `E2E_APP_LAUNCHER_SEED: 'true'` in a production manifest is inert rather than
 * merely discouraged. An unset variable is equally closed in every other
 * environment — the lane that wants the route sets it explicitly
 * (`.github/workflows/e2e.yml`, T20).
 *
 * **`404`, never `403`, and before the handler.** {@link E2eSeedEnabledGuard}
 * runs before the method body, so a refused installation performs no read, no
 * write and no validation — the route is indistinguishable from one that was
 * never mounted, and a malformed body cannot turn a `404` into a `400`. The
 * same posture as `AppLauncherEnabledGuard`
 * (`./guards/app-launcher-enabled.guard.ts:70-78`), for the same reason.
 *
 * ## Two gates, and why both are needed
 *
 * `app-launcher.module.ts` registers this controller **only when the gate is
 * open at boot** (so a production process has no such route in its router at
 * all), and the guard re-reads the gate **on every request** (so flipping the
 * variable in a running non-production process takes effect without a restart,
 * and so a process that booted with the door open and was later pointed at
 * production traffic still refuses). Neither alone is the whole guarantee: the
 * registration is what makes the route absent in production, the guard is what
 * makes the refusal a property of the request rather than of the boot.
 *
 * ## Session-authenticated, never public
 *
 * There is deliberately no `@Public()` here: unlike FR-37's catalog route this
 * one **writes**, and everything it writes belongs to the signed-in person —
 * `works.userId` is the session's user, and `tenantId` / `organizationId` come
 * from the request's own scope. A request without a session is refused twice
 * over: by the platform's global `AuthSessionGuard`
 * (`apps/api/src/auth/guards/auth-session.guard.ts:163`) and, defensively, by
 * the handler below, so a lean harness that mounts this controller without that
 * global guard still cannot mint a row for nobody.
 *
 * ## What it writes, and what it deliberately does not
 *
 * Three tables and only three: `works`, `work_deployments`,
 * `work_custom_domains`. No cluster, no build, no network, no queue, no event —
 * the route's whole job is to leave the rows a spec reads back through
 * `GET /api/me/apps` (or through the Work settings surface). It does **not**
 * touch `app_launcher_preferences`: FR-24/FR-27's arrangement is the person's
 * own state and every ACC id that exercises it does so through the real save
 * route.
 *
 * `kind: 'app'` is written as the **raw varchar** the column already is
 * (`works.kind`, `varchar(32)`, no CHECK constraint —
 * `apps/api/src/migrations/1779991010000-AddWorkKindAndStatus.ts:36-63`). APW-01
 * owns adding `'app'` to the shared `WORK_KINDS` union; nothing here edits that
 * union or the shared `WORK_KINDS` list, and nothing breaks when APW-01 adds
 * the member. See {@link seedWorkKind}.
 *
 * ## Not behind the launcher's install switch
 *
 * The gate is the plan's two variables and nothing else. `EVER_WORKS_APP_LAUNCHER_ENABLED`
 * is deliberately **not** read here: T20's flag-off lane boots the stack with
 * the launcher off, and a fixture route that went dark with it would leave the
 * off-lane unable to seed the very rows it asserts about. The route is
 * non-production exactly when the lane is, which is the property that matters.
 */

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** The variable behind the lane's switch. Named once, so nothing re-states it. */
export const E2E_APP_LAUNCHER_SEED_ENV = 'E2E_APP_LAUNCHER_SEED';

/**
 * Whatever `packages/agent/src/config/index.ts` grows for this hook, read
 * structurally — the same seam `AppLauncherEnabledGuard` uses for
 * `config.appLauncher.isEnabled()` (`./guards/app-launcher-enabled.guard.ts:51-68`).
 *
 * `isE2eSeedEnabled` does not exist there today: that file is T9's config half
 * (CONTRACTS R-40's "read through a config getter"), not this task's file, so
 * this class reads the variable itself through the same shape and will pick the
 * accessor up the moment it lands, without a second copy of the rule.
 */
interface E2eSeedConfigSeam {
    appLauncher?: { isEnabled?: () => boolean; isE2eSeedEnabled?: () => boolean };
}

/**
 * Whether this process may serve the seed route (plan §9.3, R-40).
 *
 * **Production first.** `NODE_ENV === 'production'` returns `false` before
 * `E2E_APP_LAUNCHER_SEED` — and before the config seam — is read at all, which
 * is the one property the task pins: the double refusal is a `404` in
 * production **even when the variable is set**, and a `404` for an unset
 * variable anywhere else.
 *
 * Exported so a caller that must agree with the guard — a spec, a boot-time
 * registration check in `app-launcher.module.ts` — asks this function instead
 * of re-reading the variables.
 */
export function isE2eAppLauncherSeedEnabled(): boolean {
    if (process.env.NODE_ENV === 'production') {
        return false;
    }
    const accessor = (config as E2eSeedConfigSeam | undefined)?.appLauncher;
    if (typeof accessor?.isE2eSeedEnabled === 'function') {
        return accessor.isE2eSeedEnabled() === true;
    }
    return process.env[E2E_APP_LAUNCHER_SEED_ENV] === 'true';
}

/**
 * The gate, as a guard — so it answers before the handler runs.
 *
 * A closed gate is the platform's opaque `404` (`'Cannot find route'`, the same
 * message `AppLauncherEnabledGuard` and the Fleet guard throw), never a `403`:
 * `403` would confirm that a non-production seed route exists on this host,
 * which is exactly the reconnaissance answer a fixture route must not give. The
 * check throws rather than returning `false` so the body is the platform's own
 * not-found shape and no filter has to translate it.
 */
@Injectable()
export class E2eSeedEnabledGuard implements CanActivate {
    canActivate(): boolean {
        if (!isE2eAppLauncherSeedEnabled()) {
            throw new NotFoundException('Cannot find route');
        }
        return true;
    }
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/** `work_deployments.provider` — a required column, and the fixture says who wrote it. */
export const E2E_SEED_PROVIDER = 'e2e-seed';

/** `work_deployments.branch` — required, and irrelevant to every launcher rule. */
export const E2E_SEED_BRANCH = 'main';

/** One seeded deployment row, as the caller reads it back. */
export interface E2eSeedDeploymentRead {
    id: string;
    state: string;
    environment: string;
    website: string | null;
    createdAt: string;
}

/** One seeded custom domain row, as the caller reads it back. */
export interface E2eSeedCustomDomainRead {
    id: string;
    domain: string;
    verified: boolean;
    environment: string;
    createdAt: string;
}

/**
 * What a successful seed answers.
 *
 * `workId` is the point of the response: FR-2's Work tiles are keyed
 * `work:<uuid>`, which is both the launcher item key and (through T20's
 * `app-launcher-tile-<key>` testid) the handle a spec asserts on. The rest is
 * what the fixture wrote, echoed so a spec can compute the address it expects
 * (`<managedSubdomain>.<apps domain>`) without a second read.
 */
export interface E2eSeedResponse {
    workId: string;
    slug: string;
    kind: string;
    name: string;
    tenantId: string | null;
    organizationId: string | null;
    appLauncherExposed: boolean | null;
    managedSubdomain: string | null;
    deployments: E2eSeedDeploymentRead[];
    customDomain: E2eSeedCustomDomainRead | null;
}

/**
 * `POST /api/e2e/app-launcher/seed` — write one Work fixture into the running
 * (non-production) API's own data store.
 *
 * The three repositories are injected directly rather than through
 * `WorkRepository` / `WorkDeploymentRepository` / `WorkCustomDomainRepository`,
 * because those wrappers answer the product's questions ("the Work this person
 * can see", "the deployment rows of this Work") and this route asks none of
 * them: it inserts a fixture and reads back what it inserted. Every column it
 * writes is one of the entity's own, so the platform's real schema — not a
 * fixture-shaped schema — is what validates the row.
 */
@ApiTags('App Launcher')
@ApiBearerAuth('JWT-auth')
@Controller('api/e2e/app-launcher/seed')
@UseGuards(E2eSeedEnabledGuard)
export class E2eSeedController {
    constructor(
        @InjectRepository(Work)
        private readonly works: Repository<Work>,
        @InjectRepository(WorkDeployment)
        private readonly deploymentRows: Repository<WorkDeployment>,
        @InjectRepository(WorkCustomDomain)
        private readonly domainRows: Repository<WorkCustomDomain>,
        private readonly scopeContext: ScopeContextService,
    ) {}

    /**
     * Seed one Work for the signed-in person, in the request's own scope.
     *
     * The person is the **session** and the scope is the **active request
     * scope** (FR-53, FR-24/FR-62): a caller cannot name a different owner or a
     * different workspace, so a seeded Work is visible in exactly the panel the
     * spec that seeded it is looking at.
     */
    @Post()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary: 'Seed one Work fixture (non-production only)',
        description:
            'Writes one `works` row for the signed-in person in the active scope, plus its `work_deployments` and (optionally) `work_custom_domains` rows. Answers 404 unless `NODE_ENV !== "production"` and `E2E_APP_LAUNCHER_SEED === "true"`. No cluster, no build, no network.',
    })
    @ApiResponse({ status: 201, description: 'The seeded rows, with the new Work id.' })
    @ApiResponse({ status: 400, description: 'A body outside the closed fixture shape.' })
    @ApiResponse({ status: 401, description: 'No session.' })
    @ApiResponse({
        status: 404,
        description: 'The seed route is closed (production, or the variable is unset).',
    })
    async seed(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: E2eSeedWorkDto,
    ): Promise<E2eSeedResponse> {
        // Defence in depth, not the primary refusal: the platform's global
        // `AuthSessionGuard` already answered 401 before this method ran. A
        // harness that mounts this controller without that guard must not be
        // able to write a row owned by nobody.
        const userId = typeof auth?.userId === 'string' ? auth.userId.trim() : '';
        if (userId.length === 0) {
            throw new UnauthorizedException();
        }

        const scope = this.scopeContext.getScope();
        const tenantId = normaliseScopeId(scope?.tenantId);
        const organizationId = normaliseScopeId(scope?.organizationId);
        const seededAt = new Date();

        const work = await this.works.save(
            this.works.create({
                name: body.name.trim(),
                slug: seedSlug(body),
                userId,
                tenantId,
                organizationId,
                description: '',
                kind: seedWorkKind(body.kind),
                status: 'active',
                managedSubdomain: trimmedOrNull(body.managedSubdomain),
                appLauncherExposed:
                    typeof body.appLauncherExposed === 'boolean' ? body.appLauncherExposed : null,
            }),
        );

        const deployments: E2eSeedDeploymentRead[] = [];
        for (const deployment of body.deployments ?? []) {
            const createdAt = seededTimestamp(deployment.createdAt, seededAt);
            const row = await this.deploymentRows.save(
                this.deploymentRows.create({
                    workId: work.id,
                    environment: seedDeploymentEnvironment(deployment.environment),
                    provider: E2E_SEED_PROVIDER,
                    branch: E2E_SEED_BRANCH,
                    state: deployment.state,
                    website: trimmedOrNull(deployment.website),
                    triggerSource: DeploymentTriggerSource.MANUAL,
                    startedAt: createdAt,
                    // Both admitted states are terminal (`isTerminal()`), so the
                    // fixture sets the completion time too: FR-18's `readyAt` is
                    // read off `completedAt ?? createdAt`, and a spec that
                    // asserts ordering should not depend on which of the two a
                    // half-filled row happens to have.
                    completedAt: createdAt,
                    tenantId,
                    organizationId,
                    createdAt,
                }),
            );
            deployments.push({
                id: row.id,
                state: row.state,
                environment: row.environment,
                website: row.website ?? null,
                createdAt: toIsoString(row.createdAt, createdAt),
            });
        }

        const customDomain = body.customDomain
            ? await this.seedCustomDomain(work.id, body.customDomain, seededAt)
            : null;

        return {
            workId: work.id,
            slug: work.slug,
            kind: work.kind,
            name: work.name,
            tenantId,
            organizationId,
            appLauncherExposed:
                typeof work.appLauncherExposed === 'boolean' ? work.appLauncherExposed : null,
            managedSubdomain: work.managedSubdomain ?? null,
            deployments,
            customDomain,
        };
    }

    /**
     * One `work_custom_domains` row, on the same clock as its Work.
     *
     * The table carries no `tenantId` / `organizationId` columns at all, so the
     * scope travels through the Work's own columns and nowhere else.
     */
    private async seedCustomDomain(
        workId: string,
        domain: E2eSeedCustomDomainDto,
        seededAt: Date,
    ): Promise<E2eSeedCustomDomainRead> {
        const createdAt = seededTimestamp(domain.createdAt, seededAt);
        const row = await this.domainRows.save(
            this.domainRows.create({
                workId,
                domain: domain.domain.trim().toLowerCase(),
                environment: seedDomainEnvironment(domain.environment),
                verified: domain.verified === true,
                provider: E2E_SEED_PROVIDER,
                createdAt,
            }),
        );
        return {
            id: row.id,
            domain: row.domain,
            verified: row.verified === true,
            environment: row.environment,
            createdAt: toIsoString(row.createdAt, createdAt),
        };
    }
}

// ---------------------------------------------------------------------------
// Fixture helpers (module scope: no `this`, no I/O)
// ---------------------------------------------------------------------------

/**
 * The `work.kind` a fixture asked for, as the column's own type.
 *
 * `kind: 'app'` is a **raw varchar** write until APW-01 lands: `works.kind` is
 * `varchar(32)` with no CHECK constraint, and the shared `WORK_KINDS` union this
 * cast narrows to simply does not carry the member yet. Deliberately not solved
 * by widening the union (APW-01's, not this task's) and deliberately not solved
 * by a shared helper (there is nothing to share: the launcher reads `kind`
 * through `isLauncherAppWorkKind`, which already compares strings). When APW-01
 * adds `'app'` this function becomes an identity cast and changes in one line.
 */
function seedWorkKind(kind: E2eSeedWorkDto['kind']): Work['kind'] {
    return kind as Work['kind'];
}

/** The DTO's environment string as the enum the column stores. */
function seedDeploymentEnvironment(
    environment: E2eSeedDeploymentDto['environment'],
): DeploymentEnvironment {
    return environment === 'preview'
        ? DeploymentEnvironment.PREVIEW
        : DeploymentEnvironment.PRODUCTION;
}

/** The DTO's environment string as the enum `work_custom_domains.environment` stores. */
function seedDomainEnvironment(
    environment: E2eSeedCustomDomainDto['environment'],
): DomainEnvironment {
    switch (environment) {
        case 'staging':
            return DomainEnvironment.STAGING;
        case 'development':
            return DomainEnvironment.DEVELOPMENT;
        default:
            return DomainEnvironment.PRODUCTION;
    }
}

/**
 * The fixture's own `createdAt` when it named one, else now.
 *
 * FR-58's chip and FR-16's "latest successful deployment" both read
 * `createdAt DESC`, so a fixture that must state the order of two rows states
 * it here rather than hoping two inserts land in different milliseconds.
 */
function seededTimestamp(value: string | undefined, fallback: Date): Date {
    if (typeof value !== 'string') {
        return fallback;
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

/**
 * The Work's slug: the fixture's when it named one, else a slug derived from the
 * name.
 *
 * Nothing in the platform requires the two to be related, and `works.slug` has
 * no unique index (uniqueness is a per-owner check in `WorkRepository.create`,
 * which this route does not go through) — so a derived slug is a readable
 * default, never a claim of uniqueness.
 */
function seedSlug(body: E2eSeedWorkDto): string {
    const explicit = trimmedOrNull(body.slug);
    if (explicit) {
        return explicit;
    }
    const derived = body.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return derived.length > 0 ? derived : `e2e-${Date.now().toString(36)}`;
}

/** `''`/whitespace → `null`, so an omitted fixture field stays omitted. */
function trimmedOrNull(value: string | null | undefined): string | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

/** A scope id (`tenantId` / `organizationId`) that survives a JSON round trip. */
function normaliseScopeId(value: string | null | undefined): string | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * The row's timestamp as an ISO string.
 *
 * A driver may hand back the value it was given, a `Date`, or a driver-native
 * string (better-sqlite3 stores `datetime` as text); the response is always the
 * one shape, and a value that cannot be read falls back to the time the fixture
 * was written.
 */
function toIsoString(value: Date | string | null | undefined, fallback: Date): string {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
        return value.toISOString();
    }
    if (typeof value === 'string') {
        const parsed = new Date(value);
        if (Number.isFinite(parsed.getTime())) {
            return parsed.toISOString();
        }
    }
    return fallback.toISOString();
}
