import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsISO8601,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    ValidateNested,
} from 'class-validator';

/**
 * APW-11 T33 — the fixture shapes `POST /api/e2e/app-launcher/seed` accepts.
 *
 * Spec: `docs/specs/features/app-works/APW-11-app-launcher/spec.md` (ACC-11-52);
 * plan §9.3 (`plan.md:1010-1024`, the route, its gate and this DTO) and §10.5's
 * `ACCEPTANCE E2E-12` row, which is what T20's helper
 * (`apps/web/e2e/helpers/app-launcher-seed.ts`) renders its Work states from.
 *
 * ## Why the enums are closed, and closed to exactly these members
 *
 * The route exists so a non-production lane can put rows in an in-memory data
 * store, and a **fixture** is only useful when a spec can predict it. Every
 * closed set here is therefore exactly the set an acceptance criterion needs
 * and nothing wider:
 *
 *   - `kind` — `'app' | 'website'` (FR-19's exposure default and FR-16's address
 *     order turn on `kind`, so a fixture that could write any string would be
 *     able to fake a kind the plan does not have yet);
 *   - `state` — `'READY' | 'ERROR'`, the two the plan names: a `READY` row is
 *     what makes a Work live (FR-15) and a later `ERROR` row is what earns
 *     FR-58's `lastDeployFailed` chip while the Work stays live (ACC-11-12);
 *   - `environment` — `production` and `preview` on a deployment,
 *     `DeploymentEnvironment`'s own two members, because FR-15's rule is
 *     precisely that a preview row never makes a Work live and a fixture must
 *     be able to prove that by adding one; on a custom domain the set is
 *     `DomainEnvironment`'s instead (`production | staging | development`),
 *     because that column is a different enum.
 *
 * Everything else a caller might want to "just set" (a cluster, a build, a
 * provider id, a network call) is deliberately absent: the route writes rows
 * and nothing else (T33's "no cluster, no build, no network").
 *
 * ## Why `forbidNonWhitelisted` is the second half of "closed"
 *
 * `apps/api/src/main.ts:199-205` runs the platform's `ValidationPipe` with
 * `whitelist` + `forbidNonWhitelisted`, so an unknown field is a `400` rather
 * than a silently ignored one. A helper that misspells `managedSubdomain` gets
 * an error, not a Work that quietly seeds without one.
 */

// ---------------------------------------------------------------------------
// The closed sets (plan §9.3)
// ---------------------------------------------------------------------------

/** The two Work kinds a fixture may write (APW-01 owns the shared `WORK_KINDS`). */
export const E2E_SEED_WORK_KINDS = ['app', 'website'] as const;
export type E2eSeedWorkKind = (typeof E2E_SEED_WORK_KINDS)[number];

/** `state: 'READY' | 'ERROR'` — the plan's two, spelled as the column spells them. */
export const E2E_SEED_DEPLOYMENT_STATES = ['READY', 'ERROR'] as const;
export type E2eSeedDeploymentState = (typeof E2E_SEED_DEPLOYMENT_STATES)[number];

/** `DeploymentEnvironment`'s members, restated as a runtime set for `@IsIn`. */
export const E2E_SEED_ENVIRONMENTS = ['production', 'preview'] as const;
export type E2eSeedEnvironment = (typeof E2E_SEED_ENVIRONMENTS)[number];

/**
 * `DomainEnvironment`'s members — a **different** closed set from the
 * deployment one, because the two columns are two different enums
 * (`entities/types.ts:179-183` vs `entities/work-deployment.entity.ts:15-18`).
 * A custom domain is a DNS fact (`production | staging | development`), not a
 * deployment fact, and copying the deployment set here would have admitted a
 * `preview` domain the column's own enum does not carry.
 */
export const E2E_SEED_DOMAIN_ENVIRONMENTS = ['production', 'staging', 'development'] as const;
export type E2eSeedDomainEnvironment = (typeof E2E_SEED_DOMAIN_ENVIRONMENTS)[number];

/**
 * The largest fixture one request may write. A single Work and its up-to-ten
 * deployment history rows is far more than any ACC id needs; the cap exists so
 * a malformed helper (a loop that appends to the same array) cannot turn one
 * request into an unbounded insert.
 */
export const E2E_SEED_MAX_DEPLOYMENTS = 10;

/**
 * A managed label is a DNS label (`works.managedSubdomain`, `varchar(63)`):
 * lower-case alphanumerics and inner hyphens, 1..63 characters. Validated here
 * rather than at the address builder so a fixture cannot seed a Work whose
 * label could never have been allocated — the launcher would simply drop the
 * candidate and the spec would fail somewhere far from its cause.
 */
export const E2E_SEED_HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A custom domain is a bare host — no scheme, no path, no port. Dots and inner
 * hyphens per label, up to DNS's 253 characters. `launcher-address.ts` would
 * refuse anything else at read time anyway (and that refusal is FR-55's, not
 * this DTO's); rejecting it here is what keeps the failure next to the fixture
 * that caused it.
 */
export const E2E_SEED_DOMAIN_PATTERN =
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** `works.name` / `work_custom_domains.domain` are bounded columns; so is this. */
export const E2E_SEED_NAME_MAX_LENGTH = 120;
export const E2E_SEED_SLUG_MAX_LENGTH = 80;
export const E2E_SEED_WEBSITE_MAX_LENGTH = 2_048;

// ---------------------------------------------------------------------------
// One deployment history row
// ---------------------------------------------------------------------------

/**
 * One `work_deployments` row (plan §9.3).
 *
 * `createdAt` is optional and exists for one reason: FR-58's chip and FR-18's
 * "newest row" both come from `createdAt DESC`, and ACC-11-12 asserts a Work
 * that succeeded **and then** failed. Two rows written inside one request would
 * otherwise share a timestamp, leaving the newest row to the `id DESC`
 * tie-break — a spec that passed or failed on a uuid. An explicit timestamp is
 * how the fixture states the order it means.
 */
export class E2eSeedDeploymentDto {
    @IsIn(E2E_SEED_DEPLOYMENT_STATES)
    state: E2eSeedDeploymentState;

    @IsIn(E2E_SEED_ENVIRONMENTS)
    environment: E2eSeedEnvironment;

    /** What the deployment reported — FR-16's last address candidate. */
    @IsOptional()
    @IsString()
    @MaxLength(E2E_SEED_WEBSITE_MAX_LENGTH)
    website?: string;

    @IsOptional()
    @IsISO8601()
    createdAt?: string;
}

// ---------------------------------------------------------------------------
// One custom domain row
// ---------------------------------------------------------------------------

/**
 * One `work_custom_domains` row (plan §9.3: "`verified` + `createdAt` for a
 * custom domain").
 *
 * `createdAt` is part of the fixture because FR-16's first preference is the
 * **earliest-added** verified production domain (ACC-11-10) — the date is the
 * ordering fact, not decoration.
 */
export class E2eSeedCustomDomainDto {
    @IsString()
    @MaxLength(253)
    @Matches(E2E_SEED_DOMAIN_PATTERN)
    domain: string;

    @IsBoolean()
    verified: boolean;

    @IsIn(E2E_SEED_DOMAIN_ENVIRONMENTS)
    environment: E2eSeedDomainEnvironment;

    @IsOptional()
    @IsISO8601()
    createdAt?: string;
}

// ---------------------------------------------------------------------------
// One Work fixture — the request body itself
// ---------------------------------------------------------------------------

/**
 * The body of `POST /api/e2e/app-launcher/seed`: **one** Work fixture per
 * request, in the plan's own shape —
 * `{ kind, name, managedSubdomain?, deployments: [{ state, environment, website? }], customDomain? }`.
 *
 * A `README`-style `works: [...]` wrapper was deliberately not invented: the
 * plan names the fixture shape, T20 needs five distinct Works and five calls is
 * one line in a helper, and a body that is a bare array (or a wrapper) would be
 * a second shape for a later reader to discover.
 *
 * `appLauncherExposed` is the one field past the plan's list, and it is here
 * because it is a real `works` column (FR-19) with three meaningful states —
 * `true`, `false` and "absent, follow the kind's default" — that the exposure
 * specs need to render. It is a boolean against a real column, not a free-form
 * passthrough: nothing else on the Work can be set through this route.
 */
export class E2eSeedWorkDto {
    @IsIn(E2E_SEED_WORK_KINDS)
    kind: E2eSeedWorkKind;

    @IsString()
    @MaxLength(E2E_SEED_NAME_MAX_LENGTH)
    name: string;

    /** Defaults to a slug derived from `name`; bound to the column's 80 chars. */
    @IsOptional()
    @IsString()
    @MaxLength(E2E_SEED_SLUG_MAX_LENGTH)
    slug?: string;

    @IsOptional()
    @IsString()
    @MaxLength(63)
    @Matches(E2E_SEED_HOST_LABEL_PATTERN)
    managedSubdomain?: string;

    /**
     * FR-19's explicit exposure choice. Omitted (or `null` via an absent field)
     * leaves the column NULL, which is FR-19's "follow the kind's default" —
     * the state an App Work is in before anybody touches its setting.
     */
    @IsOptional()
    @IsBoolean()
    appLauncherExposed?: boolean;

    @IsArray()
    @ArrayMaxSize(E2E_SEED_MAX_DEPLOYMENTS)
    @ValidateNested({ each: true })
    @Type(() => E2eSeedDeploymentDto)
    deployments: E2eSeedDeploymentDto[];

    @IsOptional()
    @ValidateNested()
    @Type(() => E2eSeedCustomDomainDto)
    customDomain?: E2eSeedCustomDomainDto;
}
