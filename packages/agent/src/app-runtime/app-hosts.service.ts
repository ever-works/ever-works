/**
 * APW-06 T26 (half one) — the **hosts** service: which addresses an App Work publishes, which URL
 * scheme each one is reached over, and what a change of primary address does.
 *
 * Spec: `APW-06-app-runtime/spec.md` FR-38 (`spec.md:426-430`, the primary order, "the App spec's
 * policy applies: **restart** — a Deployment of the current Build; **rebuild** — a Build, then its
 * Deployment; the previous address stays published until the new version is live"), FR-39
 * (`:431-433`, verified-only), FR-40 (`:434-441`), FR-41 (`:442-443`) and S9 (`:133-135`). Plan:
 * **§8.1** (`plan.md:1097-1104`, the host set), **§8.2** (`plan.md:1106-1118`, `domains.onChange`),
 * **§4.11** (`plan.md:612-626`, `appUrlScheme(tls, hostKind)`), **§8.3** (`:1120-1150`, the managed
 * subdomain and `getDomain()`), §7.2 (`:1042-1074`, the runtime-state row, incl.
 * `pendingDomainRebuildBuildId` at `:1057`). Task text: `tasks.md:466-481` (T26). Acceptance:
 * **ACC-06-25**, **ACC-06-26** (APW06-G11), **ACC-06-52**, and the T22 warning this file removes.
 *
 * ## This file is what makes T22's `hosts_incomplete` warning go away
 *
 * T22 consumes a **host set** through the `resolveHosts?(workId)` view it declares on T21's existing
 * `APP_DEPLOY_HOST_SOURCE` token and records `hosts_incomplete` when the bound seam cannot answer it
 * (`app-render-input.builder.ts:252-259`, `:886-892`). {@link AppHostsService} implements that view,
 * so the swap is the one provider line both consumers share —
 * `{ provide: APP_DEPLOY_HOST_SOURCE, useExisting: AppHostsService }` — and **no second `Symbol` is
 * declared anywhere in this file**. A `Symbol('APP_DEPLOY_HOST_SOURCE')` of its own would be a
 * different token (Nest compares by identity) and would silently leave one of the two consumers
 * unbound, which is why T21's own comment already prescribes the `useExisting` form
 * (`app-deploy-preconditions.service.ts:241`).
 *
 * The same class binds APW-11's `APP_PUBLISHED_HOSTS`
 * (`packages/agent/src/app-launcher/managed-host-root.resolver.ts:132-138`, whose docstring names
 * this service as its owner) through {@link AppHostsService.primary}. One service, several tokens,
 * one host set — the alternative is answers that can disagree about the app's own address.
 *
 * ## `primary` is an order, not a preference
 *
 * §8.1:1099-1102, in that order and with no fourth branch:
 *
 * 1. `targetSettings.primaryDomain` — and only while that domain is a **verified** custom-domain row
 *    of this Work. An unverified row is never published (FR-39), so a primary that is stored but
 *    not verified falls through to the managed subdomain rather than publishing a host that does
 *    not resolve;
 * 2. else `<work.managedSubdomain>.<apps apex>` when `getDomain()` answers non-null, the Work
 *    actually holds an allocated label (`works.managedSubdomain`, `work.entity.ts:747-768`) and
 *    `targetSettings.managedSubdomain` is not switched off;
 * 3. else `null` — "no *managed* address" is a legal state (`config/index.ts:1122-1127`).
 *
 * `extra` is every other **verified** row plus the managed subdomain when it is not already the
 * primary; `previous` is §8.1:1103-1104's carry-over.
 *
 * ## The one fact this file reads that the plan names no column for
 *
 * "hosts published by the current Deployment" has no column of its own. The orchestrator (T25) is
 * what knows them, and §5.6 step 5 already has it write `WorkDeployment.appRender`
 * (`plan.md:825-826`), so this file reads `appRender.hosts` — `{ primary, extra }` — through the
 * deployment-store seam and interprets it as exactly that. The interpretation is narrow on purpose:
 * an absent or unreadable `appRender` carries **no** previous hosts rather than a guess, because a
 * wrong `previous` keeps serving a host nobody asked for (§4.11:614-615).
 *
 * ## What this file deliberately does not do
 *
 * It never dials a cluster, never reads a kubeconfig, never writes a DNS record and never emits an
 * event. A non-primary add/remove is §8.2:1117-1118's `app-cluster-op { op: 'ingress-reconcile' }`,
 * which is a **dispatch** — the op handler re-applies the `Ingress` in the worker. The reconcile
 * itself, the DNS record (`ensureRecord`, §8.3:1146-1147) and the label allocation
 * (`SubdomainAllocator.allocate`, §8.3:1144-1146) belong to other tasks and are not re-implemented.
 *
 * ## Provisional seams (each routed, none silent)
 *
 * - **The runtime-state row** — T17 (`tasks.md:293-321`). The **token is not declared here**:
 *   `app-launcher.service.ts:223` declares `WORK_APP_RUNTIME_STATES` and T21/T24/T58 already reuse
 *   it, so this file declares the wider *view* it needs of that same provider and reuses the one
 *   token. `setPendingDomainRebuildBuildId` is the §8.2/§7.2:1057 write, named after its column.
 * - **The App spec read** — T21's `APP_DEPLOY_SPEC_SOURCE` (`app-deploy-preconditions.service.ts:196-197`),
 *   reused rather than re-declared, for `domains.onChange` and `build.strategy`.
 * - **The Deployment row** — T16 (`tasks.md:285-291`). Two facts only: the current Deployment's id
 *   (from the runtime state) and its `appRender.hosts`. The swap is
 *   `{ provide: APP_HOSTS_DEPLOYMENT_STORE, useExisting: WorkDeploymentRepository }`.
 * - **The custom-domain rows** — `WorkCustomDomainRepository` **has** landed
 *   (`database/repositories/work-custom-domain.repository.ts:210-215`) and `findByWork` is exactly
 *   the read §8.1 needs; the binding is
 *   `{ provide: APP_HOSTS_DOMAIN_STORE, useExisting: WorkCustomDomainRepository }`.
 * - **The Work row** — `WorkRepository.findById` supplies the three facts §8.1 needs that the
 *   runtime state does not carry: `kind`, `slug` and `managedSubdomain`.
 * - **The deploy request** — T24 **has** landed, and this service calls it through the one-method
 *   view below rather than the concrete class, so the hosts spec does not have to construct a
 *   request service (with its four collaborators) to assert that a `restart` asked for a Deployment.
 *   The binding is `{ provide: APP_HOSTS_DEPLOY_REQUESTER, useExisting: AppDeployRequestService }`.
 * - **`AppBuildsService.requestRebuild`** — APW-05 (`APW-05-builds/tasks.md:347`), not in this tree.
 *   §8.2:1110-1116 fixes the call, the answer it must store and the two refusals; the seam below is
 *   that call and nothing else.
 * - **The op dispatcher** — T58 already declares `APP_CLUSTER_OP_DISPATCHER`
 *   (`app-runtime-deletion.service.ts:477-504`) for the one op it owns; §8.2:1117-1118 asks for a
 *   second op through the same dispatcher, so this file **re-exports that token** and declares the
 *   `ingress-reconcile` payload beside it. A second `Symbol('APP_CLUSTER_OP_DISPATCHER')` would be
 *   a different token and T31's single binding would reach only one of the two callers.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { APP_DOMAIN_RECONCILE_S } from '@ever-works/contracts';

import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import {
    APP_DEPLOY_SPEC_SOURCE,
    type AppDeploySpecSource,
} from './app-deploy-preconditions.service';
import { APP_CLUSTER_OP_DISPATCHER } from './app-runtime-deletion.service';
import type { AppRenderHosts, AppRenderHostSource } from './app-render-input.builder';
import type { AppDeployTrigger } from './app-deploy-request.service';

/* -------------------------------------------------------------------------- *
 * DI tokens
 *
 * Declared **before** the class: a decorator argument is evaluated when the class
 * definition runs, so a token declared after the class is in its temporal dead
 * zone and the module throws on import.
 * -------------------------------------------------------------------------- */

/**
 * DI token for {@link AppHostsDomainStore} — bound to `WorkCustomDomainRepository`.
 *
 * Declared **here** rather than in `app-domains.service.ts` so the two files cannot form an import
 * cycle: `app-domains.service.ts` imports this file (it delegates a primary change to
 * {@link AppHostsService}), and this file imports nothing from it. `AppDomainsService` declares the
 * wider *view* it needs of the same provider and reuses this one token.
 */
export const APP_CUSTOM_DOMAIN_STORE = Symbol('APP_CUSTOM_DOMAIN_STORE');

/** DI token for {@link AppHostsWorkStore} — bound to `WorkRepository`. */
export const APP_HOSTS_WORK_STORE = Symbol('APP_HOSTS_WORK_STORE');

/** DI token for {@link AppHostsDeploymentStore} — bound to T16's `WorkDeploymentRepository`. */
export const APP_HOSTS_DEPLOYMENT_STORE = Symbol('APP_HOSTS_DEPLOYMENT_STORE');

/**
 * DI token for the apps-domain getter — bound to `config.everWorks.apps`
 * (`packages/agent/src/config/index.ts:1063-1144`). Injectable rather than read from `process.env`
 * at every call so §8.3's validation has exactly one home.
 */
export const APP_HOSTS_APPS_DOMAIN = Symbol('APP_HOSTS_APPS_DOMAIN');

/** DI token for {@link AppHostsDeployRequester} — bound to T24's `AppDeployRequestService`. */
export const APP_HOSTS_DEPLOY_REQUESTER = Symbol('APP_HOSTS_DEPLOY_REQUESTER');

/** DI token for {@link AppHostsRebuildRequester} — owned by APW-05. */
export const APP_HOSTS_REBUILD_REQUESTER = Symbol('APP_HOSTS_REBUILD_REQUESTER');

/**
 * T58's op-dispatcher token, re-exported so a caller importing this file binds the **same** key
 * (`app-runtime-deletion.service.ts:464`).
 */
export { APP_CLUSTER_OP_DISPATCHER };

/* -------------------------------------------------------------------------- *
 * Vocabulary this file adds
 * -------------------------------------------------------------------------- */

/** §4.11:621 — the two host kinds `appUrlScheme` distinguishes. */
export type AppHostKind = 'custom' | 'managed';

/** §4.11:621 — the four TLS modes an App Work's ingress can carry (`AppRenderInput['ingress']['tls']`). */
export type AppHostTlsMode = 'cert-manager' | 'external' | 'none' | 'edge';

/** §4.11:624 — the warning `tls: 'none'` carries on every host it publishes. */
export const APP_HOSTS_WARNING_TLS_DISABLED = 'tls_disabled';

/** §5.8:892-894 — `rebuild` under `build.strategy: image` behaves as `restart` and says so. */
export const APP_HOSTS_WARNING_REBUILD_NOT_APPLICABLE = 'rebuild_not_applicable';

/** §8.2:1114 — APW-05's rate-limit refusal; no marker is stored and no Deployment is requested. */
export const APP_HOSTS_CODE_REBUILD_RATE_LIMITED = 'rebuildRateLimited';

/** §8.2:1114 — "or the Build is `blocked`" (`APP_BUILD_STATUSES` carries `blocked`). */
export const APP_HOSTS_CODE_REBUILD_BLOCKED = 'blocked';

/** No dispatcher is bound in this process, so §8.2's reconcile cannot be asked for. */
export const APP_HOSTS_CODE_RECONCILE_UNAVAILABLE = 'ingress_reconcile_unavailable';

/** No App deploy request service is bound, so a `restart` cannot be requested either. */
export const APP_HOSTS_CODE_DEPLOY_UNAVAILABLE = 'deploy_request_unavailable';

/** APW-05's `requestRebuild` is not bound in this process. */
export const APP_HOSTS_CODE_REBUILD_UNAVAILABLE = 'rebuild_unavailable';

/** §8.1:1101 — the platform's own documented default, restated once (`config/index.ts:1094-1096`). */
export const APP_HOSTS_DEFAULT_APPS_DOMAIN = 'ever.works';

/**
 * §4.11:621-626's `appUrlScheme(tls, hostKind)`, as the one function every consumer uses — the
 * `EVER_WORKS_APP_URL` env value, `domains.primary.url` handed to APW-07, the Deploy tab's URL and
 * the public smoke URLs (`plan.md:625-626`).
 *
 * The table is the plan's, verbatim:
 *
 * | `tls`          | custom domain | managed subdomain |
 * | -------------- | ------------- | ----------------- |
 * | `cert-manager` | `https`       | `https`           |
 * | `external`     | `https`       | `http`            |
 * | `none`         | `http`        | `http`            |
 * | `edge`         | `https`       | `https`           |
 *
 * `external` is the one asymmetric row and the reason the host **kind** is an argument at all: an
 * outside terminator holds the certificate for a custom domain, while the managed subdomain's DNS
 * record points straight at the ingress so nothing terminates TLS in front of it (§4.11:623-624).
 */
export function appUrlScheme(
    tls: string | null | undefined,
    hostKind: AppHostKind,
): 'http' | 'https' {
    const mode = normaliseTlsMode(tls);

    if (mode === 'cert-manager' || mode === 'edge') return 'https';
    if (mode === 'external') return hostKind === 'custom' ? 'https' : 'http';

    return 'http';
}

/** {@link appUrlScheme}'s normaliser — an unknown or unset value is `cert-manager`, the selector's default. */
export function normaliseTlsMode(tls: string | null | undefined): AppHostTlsMode {
    const value = typeof tls === 'string' ? tls.trim().toLowerCase() : '';

    return value === 'external' || value === 'none' || value === 'edge' ? value : 'cert-manager';
}

/** `scheme://host` — the one spelling of an App Work's URL (§4.11:625). */
export function appHostUrl(
    host: string | null | undefined,
    tls: string | null | undefined,
    hostKind: AppHostKind,
): string | null {
    const value = text(host);

    return value ? `${appUrlScheme(tls, hostKind)}://${value}` : null;
}

/** One non-refusing report — the `{ code, message }` shape §5.4's warnings already use. */
export interface AppHostsWarning {
    code: string;
    message: string;
}

/** §8.2's `domains.onChange` values; `restart` is the App spec's documented default (`:1074`). */
export type AppDomainChangeMode = 'restart' | 'rebuild';

/* -------------------------------------------------------------------------- *
 * Provisional — APW-06 T17, the runtime-state row (token reused, never re-declared)
 * -------------------------------------------------------------------------- */

/** One `work_app_runtime_states` row as this service reads and writes it (plan §7.2:1042-1074). */
export interface AppHostsRuntimeStateView {
    target?: string | null;
    /** The live namespace, once a Deployment has frozen it (`plan.md:1050`). */
    namespace?: string | null;
    /** The Deployment this Work last reached `READY` on (`plan.md:1054`). */
    currentDeploymentId?: string | null;
    /** §7.2:1057 — "the Build requested by a `rebuild` domain change". */
    pendingDomainRebuildBuildId?: string | null;
    /** §6.3 — what `checkAppCluster` recorded; the custom-domain verify path reads its address (GAP-09). */
    ingressAddress?: { ip?: string | null; hostname?: string | null } | null;
    /** §7.2:1049 — ingress/TLS/network and the two domain switches. */
    targetSettings?: {
        tls?: string | null;
        managedSubdomain?: boolean | null;
        primaryDomain?: string | null;
    } | null;
}

/** APW-06 T17's `WorkAppRuntimeStateRepository`, as this service consumes it. */
export interface AppHostsStateStore {
    getOrCreate(workId: string): Promise<AppHostsRuntimeStateView | null>;
    /** §8.2:1112-1114 — the latest-wins `pendingDomainRebuildBuildId` write. */
    setPendingDomainRebuildBuildId?(
        workId: string,
        buildId: string | null,
    ): Promise<unknown> | unknown;
}

/* -------------------------------------------------------------------------- *
 * Provisional — APW-06 T16, the Deployment row
 * -------------------------------------------------------------------------- */

/** One `work_deployments` row as this service reads it. */
export interface AppHostsDeploymentView {
    id: string;
    buildId?: string | null;
    commitSha?: string | null;
    appRender?: {
        hosts?: { primary?: string | null; extra?: readonly string[] | null } | null;
    } | null;
}

/** APW-06 T16's `WorkDeploymentRepository`, as this service consumes it. */
export interface AppHostsDeploymentStore {
    findById?(deploymentId: string): Promise<AppHostsDeploymentView | null>;
}

/* -------------------------------------------------------------------------- *
 * Provisional — the custom-domain and Work reads
 * -------------------------------------------------------------------------- */

/** One `WorkCustomDomain` row as §8.1 reads it. */
export interface AppHostsDomainRow {
    domain: string;
    verified?: boolean | null;
}

/** `WorkCustomDomainRepository`'s `findByWork` (`work-custom-domain.repository.ts:210-215`). */
export interface AppHostsDomainStore {
    findByWork(workId: string): Promise<readonly AppHostsDomainRow[] | null>;
}

/** The three facts §8.1 needs from the Work row. */
export interface AppHostsWorkView {
    id: string;
    /** `'app'` for an App Work; compared as a string, never narrowed (APW-01 owns the union). */
    kind?: string | null;
    slug?: string | null;
    /** `works.managedSubdomain` — the allocated label, or `null` when none was allocated (EW-734). */
    managedSubdomain?: string | null;
}

/** `WorkRepository`, as this service consumes it. */
export interface AppHostsWorkStore {
    findById(workId: string): Promise<AppHostsWorkView | null>;
}

/* -------------------------------------------------------------------------- *
 * Provisional — APW-06 T24, the deploy request
 * -------------------------------------------------------------------------- */

/**
 * T24's `AppDeployRequestService` **has** landed (`app-deploy-request.service.ts:509-538`) and
 * `request()` is the method §8.2:1109 needs. The view below is that one method, so this spec can
 * assert what a `restart` asked for without constructing the request service's four collaborators.
 */
export interface AppHostsDeployRequester {
    request(request: {
        workId: string;
        userId?: string | null;
        trigger?: AppDeployTrigger;
        buildId?: string | null;
        specCommitSha?: string | null;
    }): Promise<{
        status?: string | null;
        httpStatus?: number | null;
        code?: string | null;
        deploymentId?: string | null;
        unmet?: readonly { code?: string | null; message?: string | null }[] | null;
    } | null>;
}

/* -------------------------------------------------------------------------- *
 * Provisional — APW-05's `AppBuildsService.requestRebuild`
 * -------------------------------------------------------------------------- */

/**
 * `AppBuildsService.requestRebuild(workId, { userId })` — §8.2:1110-1111, "for the deploy-branch
 * head, which records trigger **`manual`** — the only requested trigger APW-05's deployable verdict
 * accepts". APW-05 has not landed (`APW-05-builds/tasks.md:340-380`), so the answer is read
 * defensively from whichever of its documented fields carries the refusal.
 */
export interface AppHostsRebuildAnswer {
    /** APW-05's own status, when it reports one: `queued` · `blocked` · … (`APP_BUILD_STATUSES`). */
    status?: string | null;
    /** The row that was created or reused. */
    build?: { id?: string | null; status?: string | null } | null;
    /** §8.2:1113 — "also when `deduped: true`". */
    deduped?: boolean | null;
    /** The refusal code, when the request was refused rather than served. */
    code?: string | null;
    message?: string | null;
}

/** APW-05's `AppBuildsService`, as this service consumes it. */
export interface AppHostsRebuildRequester {
    requestRebuild(
        workId: string,
        opts: { userId?: string | null },
    ): Promise<AppHostsRebuildAnswer | null>;
}

/* -------------------------------------------------------------------------- *
 * Provisional — the `ingress-reconcile` op (token reused from T58)
 * -------------------------------------------------------------------------- */

/** Every op this service asks for, spelled once so a typo cannot become a second op. */
export const APP_INGRESS_RECONCILE_OP = 'ingress-reconcile' as const;

/**
 * §8.2:1117-1118's op payload: "Non-primary add/remove → `app-cluster-op { op: 'ingress-reconcile' }`
 * which re-applies only the `Ingress` (≤ 60 s)". That budget is `APP_DOMAIN_RECONCILE_S`.
 */
export interface AppIngressReconcileOpPayload {
    op: typeof APP_INGRESS_RECONCILE_OP;
    workId: string;
    /** Why the Ingress is being re-applied — names only, never a value. */
    reason: string;
    requestId?: string | null;
}

/**
 * The op dispatcher T58 already declares (`app-runtime-deletion.service.ts:477-504`), read here at
 * the one member §8.2 needs.
 */
export interface AppHostsOpDispatcher {
    dispatchAppClusterOp?(
        payload: AppIngressReconcileOpPayload,
        opts?: { delayMs?: number },
    ): Promise<string | null>;
    isEnabled?(): boolean;
    resolve?(): unknown;
}

/* -------------------------------------------------------------------------- *
 * Result shapes
 * -------------------------------------------------------------------------- */

/** The host set §8.1 resolves, plus what a caller renders beside it (T22's own `AppRenderHosts`). */
export interface AppHostsResolved extends AppRenderHosts {
    warnings: AppHostsWarning[];
}

/**
 * What {@link AppHostsService.onPrimaryChanged} did.
 *
 * `status` is a **string discriminant** on purpose: this package sets `strictNullChecks: false`,
 * under which a boolean or a union of object shapes does not narrow
 * (`app-deploy-preconditions.service.ts:157-163`).
 */
export interface AppHostsPrimaryChangeResult {
    /** `restart-requested` · `rebuild-requested` · `refused`. */
    status: string;
    /** The policy that was applied — the caller's, else the App spec's, else `restart`. */
    mode: AppDomainChangeMode;
    /** The refusal code, when nothing was requested: `rebuildRateLimited`, `blocked`, `deploy_in_progress`, … */
    code: string | null;
    reason: string | null;
    /** The Deployment a `restart` asked for. */
    deploymentId: string | null;
    /** The Build a `rebuild` asked for, and the marker §8.2:1112 stores. */
    buildId: string | null;
    pendingDomainRebuildBuildId: string | null;
    /** The host that stays published — the previous address, per FR-38 (`spec.md:428-429`). */
    publishedPrimary: string | null;
    warnings: AppHostsWarning[];
}

/** What {@link AppHostsService.onHostsChanged} did. */
export interface AppHostsReconcileResult {
    /** `dispatched` · `refused`. */
    status: string;
    code: string | null;
    reason: string | null;
    /** The op that was asked for, echoed so a caller's log line needs no constant. */
    op: string;
    dispatched: boolean;
}

/* -------------------------------------------------------------------------- *
 * The service
 * -------------------------------------------------------------------------- */

/**
 * §8.1's host set and §8.2's `domains.onChange`. Constructed in the API (the domain routes and
 * `DeployFacadeService`'s App branch) and in the worker (T25's orchestrator and T22's builder, both
 * through `APP_DEPLOY_HOST_SOURCE`).
 *
 * Every collaborator is `@Optional()`, so the class is constructible with **nothing** bound and each
 * absent one has a defined answer: an absent store means "nothing is published" or "nothing can be
 * requested", never a guessed host and never a silent success.
 */
@Injectable()
export class AppHostsService implements AppRenderHostSource {
    private readonly logger = new Logger(AppHostsService.name);

    constructor(
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly runtimeStates?: AppHostsStateStore,
        @Optional()
        @Inject(APP_CUSTOM_DOMAIN_STORE)
        private readonly domains?: AppHostsDomainStore,
        @Optional()
        @Inject(APP_HOSTS_WORK_STORE)
        private readonly works?: AppHostsWorkStore,
        @Optional()
        @Inject(APP_HOSTS_DEPLOYMENT_STORE)
        private readonly deployments?: AppHostsDeploymentStore,
        @Optional()
        @Inject(APP_HOSTS_DEPLOY_REQUESTER)
        private readonly deploys?: AppHostsDeployRequester,
        @Optional()
        @Inject(APP_HOSTS_REBUILD_REQUESTER)
        private readonly builds?: AppHostsRebuildRequester,
        @Optional()
        @Inject(APP_CLUSTER_OP_DISPATCHER)
        private readonly ops?: AppHostsOpDispatcher,
        @Optional()
        @Inject(APP_HOSTS_APPS_DOMAIN)
        private readonly appsDomain?: { getDomain(): string | null },
        @Optional()
        @Inject(APP_DEPLOY_SPEC_SOURCE)
        private readonly specs?: AppDeploySpecSource,
    ) {}

    /* ---------------------------------------------------------------------- *
     * §8.1 — the host set
     * ---------------------------------------------------------------------- */

    /**
     * §8.1's `primary`, and T21's one-method seam
     * (`app-deploy-preconditions.service.ts:244-247`). `null` ⇔ the Work publishes nothing, which is
     * a legal state (S33/FR-41) — never an error.
     */
    async primaryHost(workId: string): Promise<string | null> {
        const resolved = await this.resolveHost(workId);

        return resolved?.primary ?? null;
    }

    /**
     * APW-11's `APP_PUBLISHED_HOSTS` (`managed-host-root.resolver.ts:132-135`): "the verified custom
     * domain the owner marked primary, else `<managedSubdomain>.<apps-domain>`, else `null`" — which
     * is exactly §8.1's `primary`, so this delegates rather than restating the order a second time.
     */
    async primary(workId: string): Promise<string | null> {
        return this.primaryHost(workId);
    }

    /**
     * The whole §8.1 host set, and the method T22's `resolveHosts?` view asks for
     * (`app-render-input.builder.ts:257-259`). Answers `null` only when the Work cannot be read at
     * all — every other state is an honest host set, possibly with a `null` primary.
     */
    async resolveHosts(workId: string): Promise<AppRenderHosts | null> {
        return this.resolveHost(workId);
    }

    /** {@link resolveHosts} plus the warnings a caller renders — one read, both answers. */
    async resolveHost(workId: string): Promise<AppHostsResolved | null> {
        const id = text(workId);
        if (!id) return null;

        const work = await this.readWork(id);
        if (!work) return null;

        const state = await this.readState(id);
        const settings = state?.targetSettings ?? null;
        const rows = await this.readDomains(id);
        // FR-39 / §8.1:1102 — "Unverified rows are never rendered."
        const verified = rows.filter((row) => row.verified === true).map((row) => row.domain);
        const requestedPrimary = text(settings?.primaryDomain);

        // §8.1's step 1 — the owner's choice, and only while it is verified.
        const customPrimary = requestedPrimary
            ? (verified.find((domain) => sameHost(domain, requestedPrimary)) ?? null)
            : null;
        const managed = this.managedHost(work, settings);
        const primary = customPrimary ?? managed;
        const primaryKind: AppHostKind = customPrimary ? 'custom' : 'managed';

        const extra = verified.filter((domain) => !primary || !sameHost(domain, primary));
        if (managed && primary && !sameHost(managed, primary)) extra.push(managed);

        const warnings: AppHostsWarning[] = [];
        if (primary && normaliseTlsMode(settings?.tls) === 'none') {
            warnings.push({
                code: APP_HOSTS_WARNING_TLS_DISABLED,
                message: `TLS is off for this App Work, so ${primary} is served over http.`,
            });
        }

        const previous = await this.readPreviousHosts(id, state, [primary, ...extra]);

        return {
            primary,
            extra: dedupe(extra),
            previous,
            primaryUrl: appHostUrl(primary, settings?.tls, primaryKind),
            warnings,
        };
    }

    /**
     * §8.1:1103-1104 — the hosts the current Deployment published that are no longer in
     * `primary ∪ extra`, **while a `rebuild`-policy Deployment is pending**. Both halves are
     * required: with no pending rebuild the ingress should already have dropped them, and §4.11:614
     * keeps `previous` only "until a `rebuild`-policy Deployment succeeds".
     */
    private async readPreviousHosts(
        workId: string,
        state: AppHostsRuntimeStateView | null,
        published: readonly (string | null)[],
    ): Promise<string[]> {
        if (!text(state?.pendingDomainRebuildBuildId)) return [];

        const deploymentId = text(state?.currentDeploymentId);
        if (!deploymentId || !this.deployments?.findById) return [];

        let row: AppHostsDeploymentView | null;
        try {
            row = (await this.deployments.findById(deploymentId)) ?? null;
        } catch (error) {
            this.logger.warn(
                `Reading the current App Deployment ${deploymentId} of Work ${workId} failed (` +
                    `${messageOf(error)}); no previous host is carried over.`,
            );

            return [];
        }

        const recorded = row?.appRender?.hosts ?? null;
        const before = [text(recorded?.primary), ...(recorded?.extra ?? []).map(text)].filter(
            (host): host is string => Boolean(host),
        );

        return dedupe(
            before.filter(
                (host) => !published.some((current) => !!current && sameHost(current, host)),
            ),
        );
    }

    /**
     * §8.1's step 2 — `<work.managedSubdomain>.<apps apex>`, and all three of its conditions: an
     * apex `getDomain()` answers non-null for (§8.3's validation is that getter's, not this file's),
     * an allocated label on the Work, and `targetSettings.managedSubdomain` not switched off. A Work
     * with no allocated label gets `null` rather than a synthesised `<slug>`: §8.3 allocates through
     * `SubdomainAllocator` and persists the claim (EW-734), so a label invented here would publish a
     * host nobody allocated.
     */
    private managedHost(
        work: AppHostsWorkView,
        settings: AppHostsRuntimeStateView['targetSettings'],
    ): string | null {
        if (settings?.managedSubdomain === false) return null;

        const label = text(work.managedSubdomain);
        if (!label) return null;

        const apex = this.resolveAppsDomain();
        if (!apex) return null;

        return `${label}.${apex}`;
    }

    /** §8.3:1129-1132 — `config.everWorks.apps.getDomain()`, with the documented default behind it. */
    private resolveAppsDomain(): string | null {
        if (this.appsDomain?.getDomain) {
            try {
                return text(this.appsDomain.getDomain());
            } catch (error) {
                this.logger.warn(
                    `Reading the configured apps domain failed (${messageOf(
                        error,
                    )}); no managed App host is published.`,
                );

                return null;
            }
        }

        // No config module bound: §8.3's shared-default branch is `EVER_WORKS_DOMAIN`, and an
        // installation that allocated a managed label has one of the two variables set.
        return text(process.env.EVER_WORKS_APPS_DOMAIN) || text(process.env.EVER_WORKS_DOMAIN);
    }

    /* ---------------------------------------------------------------------- *
     * §8.2 — `domains.onChange`
     * ---------------------------------------------------------------------- */

    /**
     * The primary address changed. §8.2:1108-1116, in its own order:
     *
     * 1. resolve the policy — the caller's `mode`, else the App spec's `domains.onChange`, else
     *    `restart` (`APP_SPEC_BLOCK_DEFAULTS['domains.onChange']`);
     * 2. under `build.strategy: image` a `rebuild` becomes a `restart` carrying
     *    {@link APP_HOSTS_WARNING_REBUILD_NOT_APPLICABLE} (§5.8:892-894) — there is no Build to
     *    rebuild;
     * 3. `restart` → one `domain-change` Deployment request naming the **current** Build
     *    (§8.2:1109, "a Deployment of `currentDeployment.buildId`");
     * 4. `rebuild` → `requestRebuild` for the deploy-branch head, and its `build.id` is stored in
     *    `pendingDomainRebuildBuildId` **also when `deduped: true`**;
     * 5. a refused (`rebuildRateLimited`) or `blocked` request stores **no** marker and requests
     *    **no** Deployment — the saved primary stays and the current Deployment, and so the previous
     *    address, stays published.
     */
    async onPrimaryChanged(
        workId: string,
        opts: { userId?: string | null; mode?: AppDomainChangeMode | null } = {},
    ): Promise<AppHostsPrimaryChangeResult> {
        const id = text(workId);
        const warnings: AppHostsWarning[] = [];

        if (!id) {
            return this.primaryRefusal('restart', 'work_not_found', 'No App Work was named.', null);
        }

        const state = await this.readState(id);
        const resolved = await this.resolveMode(id, opts?.mode ?? null);
        const mode = resolved.mode;

        warnings.push(...resolved.warnings);

        if (mode === 'rebuild') {
            if (!this.builds?.requestRebuild) {
                // No APW-05 in this process: a `rebuild` that cannot rebuild must not silently
                // become a `restart` — FR-38's two policies are the owner's choice, not ours.
                return this.primaryRefusal(
                    mode,
                    APP_HOSTS_CODE_REBUILD_UNAVAILABLE,
                    'No App Builds service is bound, so a rebuild cannot be requested.',
                    state,
                    warnings,
                );
            }

            let answer: AppHostsRebuildAnswer | null;
            try {
                answer =
                    (await this.builds.requestRebuild(id, { userId: opts?.userId ?? null })) ??
                    null;
            } catch (error) {
                this.logger.warn(
                    `Requesting an App rebuild for Work ${id} failed (${messageOf(error)}).`,
                );

                return this.primaryRefusal(
                    mode,
                    APP_HOSTS_CODE_REBUILD_UNAVAILABLE,
                    'The rebuild request failed, so the saved primary stays and nothing was rebuilt.',
                    state,
                    warnings,
                );
            }

            if (isRateLimited(answer)) {
                return this.primaryRefusal(
                    mode,
                    APP_HOSTS_CODE_REBUILD_RATE_LIMITED,
                    text(answer?.message) ||
                        'Rebuilds are rate-limited right now, so the saved primary stays and the ' +
                            'previous address keeps serving.',
                    state,
                    warnings,
                );
            }

            const buildId = text(answer?.build?.id);
            if (!buildId || isBlocked(answer)) {
                return this.primaryRefusal(
                    mode,
                    APP_HOSTS_CODE_REBUILD_BLOCKED,
                    text(answer?.message) ||
                        'The Build for this rebuild was refused, so the saved primary stays and ' +
                            'the previous address keeps serving.',
                    state,
                    warnings,
                );
            }

            // §8.2:1112-1114 — also when `deduped: true`, and a later primary change overwrites it.
            await this.setPendingRebuildBuildId(id, buildId);

            return {
                status: 'rebuild-requested',
                mode,
                code: null,
                reason: null,
                deploymentId: null,
                buildId,
                pendingDomainRebuildBuildId: buildId,
                publishedPrimary: text(state?.targetSettings?.primaryDomain),
                warnings,
            };
        }

        if (!this.deploys?.request) {
            return this.primaryRefusal(
                mode,
                APP_HOSTS_CODE_DEPLOY_UNAVAILABLE,
                'No App deploy request service is bound, so a restart cannot be requested.',
                state,
                warnings,
            );
        }

        const currentBuildId = await this.currentBuildId(id, state);

        let answer: Awaited<ReturnType<AppHostsDeployRequester['request']>>;
        try {
            answer = await this.deploys.request({
                workId: id,
                userId: opts?.userId ?? null,
                trigger: 'domain-change',
                buildId: currentBuildId,
                specCommitSha: null,
            });
        } catch (error) {
            this.logger.warn(
                `Requesting an App Deployment for Work ${id} after a primary change failed (` +
                    `${messageOf(error)}).`,
            );

            return this.primaryRefusal(
                mode,
                APP_HOSTS_CODE_DEPLOY_UNAVAILABLE,
                'The Deployment request failed, so the saved primary stays and the previous ' +
                    'address keeps serving.',
                state,
                warnings,
            );
        }

        const accepted = answer?.status === 'accepted' || answer?.status === 'queued';

        if (!accepted) {
            return this.primaryRefusal(
                mode,
                text(answer?.code) || 'deploy_refused',
                text(answer?.unmet?.[0]?.message) ||
                    'The Deployment for this primary change was refused, so the saved primary ' +
                        'stays and the previous address keeps serving.',
                state,
                warnings,
            );
        }

        return {
            status: 'restart-requested',
            mode,
            code: null,
            reason: null,
            deploymentId: text(answer?.deploymentId),
            buildId: currentBuildId,
            pendingDomainRebuildBuildId: text(state?.pendingDomainRebuildBuildId),
            publishedPrimary: text(state?.targetSettings?.primaryDomain),
            warnings,
        };
    }

    /**
     * §8.2:1117-1118 — "Non-primary add/remove → `app-cluster-op { op: 'ingress-reconcile' }` which
     * re-applies only the `Ingress` (≤ 60 s)". No Deployment is requested: ACC-06-25 asserts both
     * halves, and FR-38 (`spec.md:429-430`) is why — a non-primary change moves published hosts, not
     * the running version.
     */
    async onHostsChanged(
        workId: string,
        opts: { reason?: string | null; requestId?: string | null } = {},
    ): Promise<AppHostsReconcileResult> {
        const id = text(workId);
        const runtime = this.opDispatcher();

        if (!id) {
            return {
                status: 'refused',
                code: 'work_not_found',
                reason: 'No App Work was named.',
                op: APP_INGRESS_RECONCILE_OP,
                dispatched: false,
            };
        }

        if (!runtime) {
            return {
                status: 'refused',
                code: APP_HOSTS_CODE_RECONCILE_UNAVAILABLE,
                reason:
                    'No isolated App cluster worker is available in this process, so the ingress ' +
                    `cannot be reconciled within ${APP_DOMAIN_RECONCILE_S} s.`,
                op: APP_INGRESS_RECONCILE_OP,
                dispatched: false,
            };
        }

        try {
            await runtime.dispatchAppClusterOp({
                op: APP_INGRESS_RECONCILE_OP,
                workId: id,
                reason: text(opts?.reason) || 'hosts-changed',
                requestId: text(opts?.requestId) || null,
            });

            return {
                status: 'dispatched',
                code: null,
                reason: null,
                op: APP_INGRESS_RECONCILE_OP,
                dispatched: true,
            };
        } catch (error) {
            this.logger.warn(
                `Dispatching the ingress reconcile for Work ${id} failed (${messageOf(error)}).`,
            );

            return {
                status: 'refused',
                code: APP_HOSTS_CODE_RECONCILE_UNAVAILABLE,
                reason: `The ingress reconcile could not be dispatched: ${messageOf(error)}`,
                op: APP_INGRESS_RECONCILE_OP,
                dispatched: false,
            };
        }
    }

    /**
     * §8.2's policy: the caller's `mode` wins (the route knows what the owner clicked), else the App
     * spec's `domains.onChange`, else the schema's documented `restart`
     * (`app-spec.types.ts:1074`). Under `build.strategy: image` a `rebuild` is downgraded to
     * `restart` carrying the warning §5.8:892-894 names.
     */
    private async resolveMode(
        workId: string,
        requested: AppDomainChangeMode | null,
    ): Promise<{ mode: AppDomainChangeMode; warnings: AppHostsWarning[] }> {
        const warnings: AppHostsWarning[] = [];
        const spec = await this.readSpec(workId);
        const specMode = normaliseMode(requested ?? spec?.onChange);
        const strategy = text(spec?.strategy) || 'none';

        if (specMode === 'rebuild' && strategy === 'image') {
            warnings.push({
                code: APP_HOSTS_WARNING_REBUILD_NOT_APPLICABLE,
                message:
                    'This App Work publishes an image rather than building one, so a rebuild is ' +
                    'a restart: the recorded spec commit and digest are redeployed.',
            });

            return { mode: 'restart', warnings };
        }

        return { mode: specMode, warnings };
    }

    /* ---------------------------------------------------------------------- *
     * The reads
     * ---------------------------------------------------------------------- */

    private async readWork(workId: string): Promise<AppHostsWorkView | null> {
        if (!this.works?.findById) return null;

        try {
            return (await this.works.findById(workId)) ?? null;
        } catch (error) {
            this.logger.warn(
                `Reading the Work ${workId} for its App hosts failed (${messageOf(error)}).`,
            );

            return null;
        }
    }

    /** One guarded state read. An unreadable row is "nothing is on record", never a guessed host. */
    private async readState(workId: string): Promise<AppHostsRuntimeStateView | null> {
        if (!this.runtimeStates?.getOrCreate) return null;

        try {
            return (await this.runtimeStates.getOrCreate(workId)) ?? null;
        } catch (error) {
            this.logger.warn(
                `Reading the App runtime state of Work ${workId} failed (${messageOf(
                    error,
                )}); no managed or carried-over host is published.`,
            );

            return null;
        }
    }

    private async readDomains(workId: string): Promise<AppHostsDomainRow[]> {
        if (!this.domains?.findByWork) return [];

        try {
            const rows = await this.domains.findByWork(workId);

            return [...(rows ?? [])].filter(
                (row): row is AppHostsDomainRow => !!row && !!text(row.domain),
            );
        } catch (error) {
            this.logger.warn(
                `Reading the custom domains of Work ${workId} failed (${messageOf(
                    error,
                )}); only the managed host is published.`,
            );

            return [];
        }
    }

    /** §8.2:1109's "`currentDeployment.buildId`", read through the same T16 seam as `previous`. */
    private async currentBuildId(
        workId: string,
        state: AppHostsRuntimeStateView | null,
    ): Promise<string | null> {
        const deploymentId = text(state?.currentDeploymentId);
        if (!deploymentId || !this.deployments?.findById) return null;

        try {
            const row = (await this.deployments.findById(deploymentId)) ?? null;

            return text(row?.buildId);
        } catch (error) {
            this.logger.warn(
                `Reading the current App Deployment of Work ${workId} failed (${messageOf(
                    error,
                )}); the Deployment is requested without a Build.`,
            );

            return null;
        }
    }

    private async setPendingRebuildBuildId(workId: string, buildId: string): Promise<void> {
        if (!this.runtimeStates?.setPendingDomainRebuildBuildId) return;

        try {
            await this.runtimeStates.setPendingDomainRebuildBuildId(workId, buildId);
        } catch (error) {
            this.logger.warn(
                `Storing the pending domain rebuild Build ${buildId} for Work ${workId} failed (` +
                    `${messageOf(error)}).`,
            );
        }
    }

    /** The App spec's `domains.onChange` and `build.strategy` — the two facts §8.2 branches on. */
    private async readSpec(
        workId: string,
    ): Promise<{ onChange?: string | null; strategy?: string | null } | null> {
        if (!this.specs?.getEffectiveSpec) return null;

        try {
            const snapshot = (await this.specs.getEffectiveSpec(workId, null)) ?? null;
            const spec = snapshot?.spec as
                | {
                      domains?: { onChange?: string | null } | null;
                      build?: { strategy?: string | null } | null;
                  }
                | null
                | undefined;

            return {
                onChange: text(spec?.domains?.onChange),
                strategy: text(spec?.build?.strategy),
            };
        } catch (error) {
            this.logger.warn(
                `Reading the App spec of Work ${workId} for its domain policy failed (` +
                    `${messageOf(error)}); the documented default (restart) applies.`,
            );

            return null;
        }
    }

    /** The same two-shape reading T24 uses (`app-deploy-request.service.ts:739-762`). */
    private opDispatcher(): AppHostsOpDispatcher | null {
        const provider = this.ops;
        if (!provider) return null;

        try {
            if (typeof provider.isEnabled === 'function' && provider.isEnabled() === false) {
                return null;
            }

            const resolved = typeof provider.resolve === 'function' ? provider.resolve() : provider;
            if (!resolved) return null;

            return typeof (resolved as AppHostsOpDispatcher).dispatchAppClusterOp === 'function'
                ? (resolved as AppHostsOpDispatcher)
                : null;
        } catch (error) {
            this.logger.warn(
                `Resolving the App cluster-op dispatcher failed (${messageOf(
                    error,
                )}); App cluster work is treated as not isolated.`,
            );

            return null;
        }
    }

    private primaryRefusal(
        mode: AppDomainChangeMode,
        code: string,
        reason: string,
        state: AppHostsRuntimeStateView | null,
        warnings: AppHostsWarning[] = [],
    ): AppHostsPrimaryChangeResult {
        return {
            status: 'refused',
            mode,
            code,
            reason,
            deploymentId: null,
            buildId: null,
            pendingDomainRebuildBuildId: text(state?.pendingDomainRebuildBuildId),
            publishedPrimary: text(state?.targetSettings?.primaryDomain),
            warnings,
        };
    }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers
 * -------------------------------------------------------------------------- */

function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Host comparison: DNS names are case-insensitive and a trailing dot is the same name. */
export function sameHost(left: string, right: string): boolean {
    return normaliseHost(left) === normaliseHost(right);
}

/** One spelling of a host: lower-case, no trailing dot, no surrounding whitespace. */
export function normaliseHost(host: string | null | undefined): string {
    return typeof host === 'string' ? host.trim().toLowerCase().replace(/\.+$/, '') : '';
}

function dedupe(values: readonly (string | null)[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const value of values) {
        const host = text(value);
        if (!host) continue;

        const key = normaliseHost(host);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(host);
    }

    return out;
}

function normaliseMode(value: unknown): AppDomainChangeMode {
    return text(value) === 'rebuild' ? 'rebuild' : 'restart';
}

/** §8.2:1114's first refusal: "If the request is refused (`rebuildRateLimited`)". */
function isRateLimited(answer: AppHostsRebuildAnswer | null): boolean {
    const code = text(answer?.code);
    const status = text(answer?.status);

    return (
        code === APP_HOSTS_CODE_REBUILD_RATE_LIMITED ||
        code === 'rate_limited' ||
        status === APP_HOSTS_CODE_REBUILD_RATE_LIMITED
    );
}

/** §8.2:1114's second: "or the Build is `blocked`" (`APP_BUILD_STATUSES` carries `blocked`). */
function isBlocked(answer: AppHostsRebuildAnswer | null): boolean {
    return (
        text(answer?.code) === APP_HOSTS_CODE_REBUILD_BLOCKED ||
        text(answer?.status) === APP_HOSTS_CODE_REBUILD_BLOCKED ||
        text(answer?.build?.status) === APP_HOSTS_CODE_REBUILD_BLOCKED
    );
}
