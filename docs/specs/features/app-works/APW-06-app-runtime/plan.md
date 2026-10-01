# Implementation Plan: App runtime on Kubernetes

> Translates [`spec.md`](./spec.md) into architecture and tech choices. The plan owns implementation detail;
> the spec owns behaviour. **Every path below was opened in the worktree before it was written down**; paths
> marked _(new)_ do not exist yet.

**Epic ID**: `APW-06-app-runtime`
**Spec**: [`./spec.md`](./spec.md) · **Tasks**: [`./tasks.md`](./tasks.md)
**Status**: `Draft`
**Last updated**: 2026-09-17
**Contracts**: [`../CONTRACTS.md`](../CONTRACTS.md) — names below marked **C** are binding there.

> **Program audit resolutions** ([CONTRACTS §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5))
> binding on this plan: **R-1** shared types in `packages/contracts/src/apps/` (§5.3); **R-2** Activity `actionType`
> families `app_deploy`, `app_job`, `app_smoke`, `app_health` (§9.4); **R-3** no `licenseAttestation` here — eligibility
> is read from APW-03's `AppLicenseService.getHostingEligibility` (§5.2, §7.2); **R-5** on Ever Works Apps the platform
> renders and hands desired state to APW-10's `apps-tier` deployment plugin and never applies workloads; managed work
> calls `AppsTierPolicy` (§2.1, §5.6, §9.6); **R-10** `AppRenderInput.purpose: 'verification'` (§3, §4.12); **R-12**
> target value `none`, label "None — don't deploy yet" (§7.2, §10); **R-15** deleting an App Work (§9.7); **R-16** the
> managed subdomain on Your cluster in Wave 1 (§8.1, §8.3); **R-22** no `apps/api/test/` suites (§12); **R-24** Ever Works
> Apps requires the tier's sandboxed runtime from Wave 2 (§5.1).

---

## 1. Current state in the codebase

### 1.1 What ships today

| Layer         | File                                                                                                                                                                                                                                                                                                                                                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract      | [`packages/plugin/src/contracts/capabilities/deployment.interface.ts`](../../../../../packages/plugin/src/contracts/capabilities/deployment.interface.ts)                                                                                                                                                                                                  | `IDeploymentPlugin` (`deploy`, `getDeploymentStatus`, domain ops, `getWorkflowFilenames?`, `getDeploymentSecrets?`), `DeploymentLookupContext` (work-scoped `settingsOverride`, `namespaceOverride`, `kubeContextOverride`). No App members.                                                                                                                                                                               |
| Plugin        | [`packages/plugins/k8s/src/k8s.plugin.ts`](../../../../../packages/plugins/k8s/src/k8s.plugin.ts)                                                                                                                                                                                                                                                          | Singleton with an **unscoped** `PluginContext` — Work settings arrive only via `settingsOverride`. `deploy()` builds `image = <registry base>/<imageName>:<gitSha truncated to 12>`, ensures the namespace, applies pull Secret → runtime-env Secret → Deployment → Service → Ingress, returns `deploying` and reports failures as `status: 'error'`. `CONTAINER_PORT = 3000` is fixed.                                    |
| Renderer      | [`packages/plugins/k8s/src/manifest.renderer.ts`](../../../../../packages/plugins/k8s/src/manifest.renderer.ts)                                                                                                                                                                                                                                            | `buildDeployment` / `buildService` / `buildIngress` / `buildRuntimeEnvSecret` / `buildImagePullSecret`. One container `app`, selector `app.kubernetes.io/name: <slug>`, probes on `/` and `/api/health`, `FIELD_MANAGER = 'ever-works-k8s-plugin'`. Its pod and container defaults are chosen for platform-generated sites; App defaults for user-controlled code are defined in §4.4.                                     |
| API wrapper   | [`packages/plugins/k8s/src/k8s-api.service.ts`](../../../../../packages/plugins/k8s/src/k8s-api.service.ts)                                                                                                                                                                                                                                                | SSA through `KubernetesObjectApi.patch(..., force=true, 'application/apply-patch+yaml')` — **kind-agnostic**. Reads: namespace, Deployment, Ingress, IngressClasses, Nodes. `listManagedDeployments` selects `ever-works.io/managed=true` across all namespaces. No delete, scale, Job, CronJob, PVC, NetworkPolicy, logs, ReplicaSet or access-review calls.                                                              |
| Status        | [`packages/plugins/k8s/src/status.mapper.ts`](../../../../../packages/plugins/k8s/src/status.mapper.ts)                                                                                                                                                                                                                                                    | `mapDeploymentToStatus`: `Available=True → ready`. `isRolloutComplete` exists but has no production caller and is not the predicate App rollouts need (§5.4).                                                                                                                                                                                                                                                              |
| Kubeconfig    | [`packages/plugins/k8s/src/kubeconfig.parser.ts`](../../../../../packages/plugins/k8s/src/kubeconfig.parser.ts)                                                                                                                                                                                                                                            | Validates context/cluster/user presence, reports `requiresExecPlugin`, fingerprints `server + CA`. It checks structure; the stricter rules App Works apply to a kubeconfig pasted for user-controlled code live in the App guard (§6.1).                                                                                                                                                                                   |
| Registries    | [`packages/plugins/k8s/src/registries/github.provider.ts`](../../../../../packages/plugins/k8s/src/registries/github.provider.ts)                                                                                                                                                                                                                          | `imageBase`, `resolveVisibility` (`auto` → mirrors the website repo), `pullSecretCredentials` (password injected by caller).                                                                                                                                                                                                                                                                                               |
| Ingress       | [`packages/plugins/k8s/src/ingress/strategy.ts`](../../../../../packages/plugins/k8s/src/ingress/strategy.ts), [`domain.handler.ts`](../../../../../packages/plugins/k8s/src/domain.handler.ts)                                                                                                                                                            | Strategy registry (nginx, traefik, generic) for annotations + TLS; `buildDnsGuidance` (A for two-label hosts, CNAME otherwise); `verifyDomainResolution` against the LB target.                                                                                                                                                                                                                                            |
| Orchestrator  | [`apps/api/src/plugins-capabilities/deploy/deploy.service.ts`](../../../../../apps/api/src/plugins-capabilities/deploy/deploy.service.ts)                                                                                                                                                                                                                  | `deploy()` refuses `repo` first, then always does website-repo work (enable workflows, push Actions secrets, cron/webhook secrets), creates a `WorkDeployment`, and either calls `deployServerSideManaged` (managed clusters only) or dispatches a workflow. **Synchronous inside the HTTP request.**                                                                                                                      |
| Orchestrator  | same — `deployServerSideManaged`, `collectServerSideRuntimeEnv`, `resolveGhcrReadToken`, `mergeCustomDomainHosts`                                                                                                                                                                                                                                          | Image tag is the **branch alias** (`prod`/`dev`/…), `revision` only an annotation. Runtime env and the pull credential are assembled for platform-generated sites, which need platform and Git credentials. `mergeCustomDomainHosts` merges stored domain rows into the Ingress host list for those sites.                                                                                                                 |
| Matrix        | [`packages/agent/src/facades/deployment-context.resolver.ts`](../../../../../packages/agent/src/facades/deployment-context.resolver.ts), [`apps/api/.../cluster-source-matrix.ts`](../../../../../apps/api/src/plugins-capabilities/deploy/cluster-source-matrix.ts)                                                                                       | `resolveEffectiveDeploymentContext`: `custom-kubeconfig` honours the user's single plugin-level `namespace` (default `ever-works`); shared/managed sources get **one namespace per owner user** (`{base}-{userId}`); `isReservedDeployNamespace`; `validateClusterSourceForOwner` keyed on the website owner.                                                                                                              |
| Verifier      | [`apps/api/.../tasks/deployment-verifier.service.ts`](../../../../../apps/api/src/plugins-capabilities/deploy/tasks/deployment-verifier.service.ts)                                                                                                                                                                                                        | In-process `setInterval` (10 s, 13 min), keyed by `work.getWebsiteRepo()`; lost on restart; terminal events `DeploymentCompletedEvent` / `DeploymentFailedEvent`.                                                                                                                                                                                                                                                          |
| Controller    | [`apps/api/.../deploy.controller.ts`](../../../../../apps/api/src/plugins-capabilities/deploy/deploy.controller.ts)                                                                                                                                                                                                                                        | `POST /api/deploy/works/:id` (200, synchronous), `GET /works/:id/deployments` (limit 50), `POST /works/:id/rollback` (re-deploys `branch` + `commitSha` → for the server-side path that is the same alias image), domains, `GET/PUT /works/:id/subdomain`.                                                                                                                                                                 |
| Subdomains    | [`packages/agent/src/ever-works-providers/subdomain-allocator.service.ts`](../../../../../packages/agent/src/ever-works-providers/subdomain-allocator.service.ts)                                                                                                                                                                                          | `allocate(work, dnsOps?)`: reuse `work.managedSubdomain`, else slug → probe DB + `recordExists` → `-<4 hex>` suffixes, 5 tries; root domain from `dnsOps.rootDomain()` or `EVER_WORKS_DOMAIN`. Global unique index on the label.                                                                                                                                                                                           |
| DNS           | [`packages/agent/src/ever-works-providers/cloudflare-dns.provider.ts`](../../../../../packages/agent/src/ever-works-providers/cloudflare-dns.provider.ts), [`packages/plugin/.../dns.interface.ts`](../../../../../packages/plugin/src/contracts/capabilities/dns.interface.ts)                                                                            | `CloudflareDnsProvider(config)` implements `IDnsOperations` (`ensureRecord`, `removeRecord`, `recordExists`, `rootDomain`); `EverWorksDnsService` builds one from `CLOUDFLARE_*` + `EVER_WORKS_DOMAIN`.                                                                                                                                                                                                                    |
| Quota         | [`packages/agent/src/ever-works-providers/ever-works-deploy-quota.service.ts`](../../../../../packages/agent/src/ever-works-providers/ever-works-deploy-quota.service.ts)                                                                                                                                                                                  | Counter behind a DI token; fails **closed** when the feature is on and the counter is missing.                                                                                                                                                                                                                                                                                                                             |
| Entity        | [`packages/agent/src/entities/work-deployment.entity.ts`](../../../../../packages/agent/src/entities/work-deployment.entity.ts)                                                                                                                                                                                                                            | `state` varchar (`INITIALIZING`…`READY`/`ERROR`/`CANCELED`/`TIMEOUT`), `environment` production/preview, `prNumber`, `providerProjectId`, `providerDeploymentId`, `commitSha`, `lastError`, scope columns. `isTerminal()` hard-codes four states.                                                                                                                                                                          |
| Notifications | [`packages/agent/src/notifications/core-event-catalogue.ts`](../../../../../packages/agent/src/notifications/core-event-catalogue.ts), [`notification.service.ts`](../../../../../packages/agent/src/notifications/notification.service.ts)                                                                                                                | Snake-case event keys upserted on boot; `event-registry-coverage.spec.ts` fails on an unregistered producer key; `create(dto)` with `deduplicationKey`, `eventKey`, `isPersistent`.                                                                                                                                                                                                                                        |
| Activity      | [`apps/api/src/activity-log/activity-log.listener.ts`](../../../../../apps/api/src/activity-log/activity-log.listener.ts), [`packages/agent/src/events/deployment.events.ts`](../../../../../packages/agent/src/events/deployment.events.ts)                                                                                                               | `@OnEvent` → `ActivityLogService.log({ actionType: DEPLOYMENT, action, status, summary, details })`.                                                                                                                                                                                                                                                                                                                       |
| Jobs          | [`packages/agent/src/tasks/_tasks-symbols.ts`](../../../../../packages/agent/src/tasks/_tasks-symbols.ts), [`work-import-dispatcher.ts`](../../../../../packages/agent/src/tasks/work-import-dispatcher.ts), [`packages/tasks/src/tasks/trigger/deploy-ready-poller.task.ts`](../../../../../packages/tasks/src/tasks/trigger/deploy-ready-poller.task.ts) | `*_DISPATCHER` symbol + interface; symbol names pinned in `TASKS_BARREL_RUNTIME_SYMBOLS`; scheduled tasks use `schedules.task` + `NestFactory.createApplicationContext(TriggerInternalModule)`. **`TriggerInternalModule` is proxy-only** — every provider in it is a `createRemoteProxy` entry, so a task that boots it makes every call inside the API. App runtime tasks boot `TriggerAppRuntimeModule` instead (§6.4). |
| Jobs          | [`packages/tasks/src/trigger/worker/modules/trigger-worker.module.ts`](../../../../../packages/tasks/src/trigger/worker/modules/trigger-worker.module.ts), [`trigger-workflow-run.module.ts`](../../../../../packages/tasks/src/trigger/worker/modules/trigger-workflow-run.module.ts)                                                                     | The two existing worker compositions to model §6.4 on. `TriggerWorkerModule` imports real agent services; `TriggerWorkflowRunModule` imports `DatabaseModule`, which the isolated App runtime worker must **not**.                                                                                                                                                                                                         |
| Web           | [`apps/web/src/app/[locale]/(dashboard)/works/[id]/deploy/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/works/[id]/deploy/page.tsx>)                                                                                                                                                                                                    | **Redirects to Overview when `!work.websiteRepositoryInitialized && !work.website`** — an App Work would never see its Deploy tab. Renders `DeployForm`, `SubdomainManagement`, `DomainManagement`, `RuntimeEnvManagement`, `DeployProgressPanel`.                                                                                                                                                                         |
| Web           | [`apps/web/src/lib/api/plugins-capabilities/deploy.ts`](../../../../../apps/web/src/lib/api/plugins-capabilities/deploy.ts), [`apps/web/src/app/api/works/[id]/deploy/status/route.ts`](../../../../../apps/web/src/app/api/works/[id]/deploy/status/route.ts)                                                                                             | `server-only` client; a BFF status route polled every 3 s by `DeployProgressPanel`, authenticated from the cookie.                                                                                                                                                                                                                                                                                                         |
| e2e           | [`packages/plugins/k8s/src/__tests__/e2e/cluster.e2e.spec.ts`](../../../../../packages/plugins/k8s/src/__tests__/e2e/cluster.e2e.spec.ts), [`vitest.e2e.config.ts`](../../../../../packages/plugins/k8s/vitest.e2e.config.ts)                                                                                                                              | kind + ingress-nginx, `KUBECONFIG_E2E_PATH`, serial, 60 s default timeouts. kind's default network plugin does **not** enforce NetworkPolicy.                                                                                                                                                                                                                                                                              |

### 1.2 What makes the App renderer harder than it looks

1. **Nothing in the website path is reusable end to end.** `DeployService.deploy()` performs website-repo side
   effects before it knows the provider path; App Works have no website repository. The App path must branch
   **before** line one of that work, exactly where the `repo` refusal sits, and delegate.
2. **Wrong "ready".** `Available=True` stays true while a broken new ReplicaSet crash-loops behind a healthy old
   one. The App path needs its own rollout predicate that also compares generations and updated replicas (§5.4).
3. **Image identity.** The plugin cannot address a digest (`sanitiseDockerTag` strips `@`, the tag is
   truncated to 12 chars) and the server-side path deploys a mutable alias, so today's rollback redeploys the
   same image. The App path takes a digest-pinned reference from `WorkBuild` and never builds a tag. For
   `build.strategy: image` there is no `WorkBuild` at all: the reference comes from `spec.build.image` in the
   App spec at the Deployment's spec commit and is resolved to a digest once (§5.8).
4. **Secrets that must not reach user code.** `collectServerSideRuntimeEnv` and `resolveGhcrReadToken` assemble
   env and pull credentials for platform-generated sites, which legitimately need platform and Git credentials.
   User-controlled code must receive neither, so neither may be called for kind `app`.
5. **Namespaces.** Custom clusters share one plugin-level namespace per user; managed clusters one per owner.
   The App path needs one per App Work, persisted, and cannot take it from plugin settings.
6. **Selectors are immutable and labels leak into old listings.** Reusing `app.kubernetes.io/name` or
   `ever-works.io/managed=true` would make App components appear in `listProjects` /
   `listManagedDeployments`. App objects use a disjoint label set (§4.1) so those return exactly what they
   return today.
7. **Who dials the cluster.** Today plugin calls run in the API process. App Works require every cluster call
   to run in an isolated worker (spec FR-5), so status reads and logs become jobs with cached results, and
   the API never holds an App Work kubeconfig in memory. The API never **loads, parses or dials** an App Work
   kubeconfig: it only receives it in the save request of `POST :id/app-target/check` and stores it encrypted
   (§9.1). It never calls `validateConnection` for kind `app` (§6.2).
8. **The verifier is in-memory and keyed by website repo.** The App path does not use it; `app-deploy` is a
   durable job that owns its own waiting.
9. **Domains patch the live Ingress by website repo name.** `DeployFacadeService.addDomain/removeDomain` call
   the plugin with a project id derived from the website repo; App Works need an App branch that stores the
   row and reconciles published hosts through the worker.
10. **Minimum permissions on user clusters.** The documented service-account recipe binds `edit` in a single
    namespace. `edit` cannot create namespaces, `LimitRange` or `ResourceQuota`. The connection check must
    report this precisely, and the App path must support a pre-created namespace (§6.3).

### 1.3 Reused, not rebuilt

- SSA mechanics and `FIELD_MANAGER` (`k8s-api.service.ts`), the ingress strategy registry, `buildDnsGuidance`,
  `verifyDomainResolution`, `normaliseIngressHost`-equivalent validation, `hashRuntimeEnv`'s canonical form.
- `SubdomainAllocator.allocate(work, dnsOps)` with an apps-domain `IDnsOperations` (its `rootDomain()` wins).
- `CloudflareDnsProvider` constructed with apps-zone configuration, mirroring `EverWorksDnsService`.
- `validateClusterSourceForOwner` (keyed on the **Work Repository** owner) and `isReservedDeployNamespace`.
- `WorkDeployment` rows, `GET /api/deploy/works/:id/deployments`, custom-domain rows and routes.
- `NotificationService.create` + the core event catalogue; `ActivityLogService` via events.
- The quota pattern of `EverWorksDeployQuotaService` (fail closed).

---

## 2. Architecture

### 2.1 Pieces and seams

```
 apps/web ── Deploy tab (App branch), Overview health card ── server actions ──┐
                                                                                ▼
 apps/api  AppRuntimeController  (/api/works/:id/deploy | app-status | app-jobs | app-rollback |
           app-lifecycle | app-logs | app-target)   DeployService/DeployController: kind app → delegate
                │ 202 only; never dials a cluster
                ▼
 packages/agent  app-runtime/  AppDeployRequestService (preconditions, locks, queue) ── ports:
                │                AppsTierPolicy (APW-10) · AppImagePullCredentialSource (APW-05)
                │                AppRuntimeEnvSource (APW-07) · WorkAppSpecState/WorkBuild reads
                │  *_DISPATCHER
                ▼
 packages/tasks  app-deploy · app-smoke · app-cluster-op · app-health-poll · app-preview-gc
                │  queue "app-cluster-io"  — runs only on the isolated worker (§6.2)
                ▼
 AppRuntimeFacadeService ──► your-cluster:    IDeploymentPlugin (supportsApps) = packages/plugins/k8s  src/app/*
                         │                     deployApp · getAppStatus · runAppJob · scaleApp · getAppLogs ·
                         │                     checkAppCluster · destroyApp
                         └► ever-works-apps: IDeploymentPlugin (supportsApps) that also declares `apps-tier`
                                               (APW-10's plugin) — deployApp writes desired state (a `Work`
                                               resource) into the tier's control namespace; the zone renders it
                                               with this epic's pure renderer + non-overridable overlays (R-5)
```

- **Plugin-first (Constitution I–II).** Everything that speaks Kubernetes lives in the `k8s` plugin under a new
  `src/app/` folder. Core resolves the plugin through `AppRuntimeFacadeService` by capability, never by id: for
  `your-cluster` the deployment plugin with `supportsApps === true` for the Work's `deployProvider` that does **not**
  declare `apps-tier`; for `ever-works-apps` the enabled deployment plugin with `supportsApps === true` **and** the
  `apps-tier` capability, only while `AppsTierPolicy.isOpen()` (Resolution R-5 — no read of
  `EVER_WORKS_APPS_MANAGED_ENABLED` anywhere in this epic).
- **Renderer as a library (R-5).** `src/app/` renderer files are pure and exported from the `k8s` plugin package entry
  (`packages/plugins/k8s/src/index.ts` → `renderAppManifests`, `validateRenderInput`, name/label helpers) so APW-10's
  in-zone controller renders the same objects; the platform never sends rendered manifests to the tier.
- **Ports for parallel epics.** APW-06 owns three small interfaces in
  `packages/agent/src/app-runtime/ports.ts` _(new)_; APW-05, APW-07 and APW-10 implement them. Until an
  implementation is bound, the default binding refuses with a named precondition (`env_source_unavailable`,
  …) so nothing silently deploys half-configured.

### 2.2 Request flow — Deploy

1. `POST /api/works/:id/deploy { buildId?, specCommitSha?, confirmClusterChange? }` →
   `AppWorkAccessService.resolve(id, user, 'edit')` (CONTRACTS §2A), then the kind check.
2. `AppDeployRequestService.request()` evaluates preconditions that need no cluster (§5.1). Unmet → `422
{ code: 'APP_DEPLOY_PRECONDITIONS', unmet: AppPrecondition[] }`.
3. Atomic claim on `work_app_runtime_states`:
   `UPDATE … SET "deployLockId" = :id, "deployLockedAt" = now() WHERE "workId" = :w AND "deployLockId" IS NULL`.
   0 rows → manual: `409 { code: 'APP_DEPLOY_IN_PROGRESS', deploymentId }`; Build-triggered: write
   `queuedBuildId` (replacing and marking any previous queued row `SUPERSEDED`).
4. Create `WorkDeployment { state: 'INITIALIZING', provider: plugin.id, buildId, appTarget, … }`. For
   `build.strategy: image` (§5.8) `buildId` is `null` and `specCommitSha` is the request's, or the
   deploy-branch head; sending `buildId` for that strategy returns `400 build_not_applicable`.
5. `APP_DEPLOY_DISPATCHER.dispatchAppDeploy({ workId, deploymentId, … })` → `202 { deploymentId }` (≤ 2 s).
   The dispatch is checked **before** the lock claim: when no dispatcher is available (§9.2) the request
   returns `422 worker_not_isolated` and no row is created.
6. Worker `app-deploy` (§5) → plugin `deployApp(input, credential, hooks)` → hooks persist phases, run public
   smoke, check cancellation → terminal state, events, notification, lock release, dequeue.

### 2.3 Request flow — status, logs, lifecycle

`GET app-status` reads `work_app_runtime_states.statusSnapshot` only. `POST app-status/refresh`,
`POST app-logs`, `POST app-lifecycle`, `POST app-jobs/:name/run`, `POST app-target/check` and
`PUT app-target` dispatch `app-cluster-op` with an `op`
discriminator and return `202 { requestId }`; results land in the runtime-state row (status, lifecycle,
check, namespace preparation) or in the shared cache (logs and op outcomes, 300 s) and are polled by the web
client. The router that runs them inside the worker is `app-cluster-op.router.ts` and the op bodies are
`app-lifecycle-ops.service.ts` (§9.10). Every 202 leaves an entry under `CACHE_MANAGER` key
`app-op:<workId>:<requestId>` = `{ op, state: 'queued'|'running'|'done'|'failed', code? }`, TTL 300 000 ms,
written `queued` at dispatch by the API and overwritten by the worker, so a failed op has somewhere to land.
`GET app-status` returns entries younger than 300 s as `ops[]`.

---

## 3. Plugin contract additions

`packages/plugin/src/contracts/capabilities/app-deployment.types.ts` _(new)_, re-exported from the capabilities
barrel. All members are **optional** on `IDeploymentPlugin` (Constitution X — Vercel and third-party plugins
compile unchanged). Names marked **C**.

```ts
export type AppDeployTarget = 'your-cluster' | 'ever-works-apps';
export type AppDeployPhase =
	| 'prepare'
	| 'pre-deploy-jobs'
	| 'rollout'
	| 'first-deploy-jobs'
	| 'in-cluster-smoke'
	| 'publish'
	| 'public-smoke'
	| 'post-deploy-jobs'
	| 'cron'
	| 'rollback'
	| 'done';

export interface AppTargetRef {
	workId: string;
	namespace: string;
	target: AppDeployTarget;
	kubeContext?: string | null;
	clusterFingerprint?: string;
}

export interface AppRenderInput {
	ref: AppTargetRef;
	/** R-10: 'verification' = per-attempt namespace for APW-04 (§4.12); default 'deploy'. */
	purpose?: 'deploy' | 'verification';
	/** Required when purpose = 'verification'; written as the namespace's expiry annotation. */
	ttlMinutes?: number;
	workSlug: string;
	deploymentId: string;
	deploymentShort: string; // 8 hex
	specCommitSha: string;
	isFirstDeploymentOnCluster: boolean;
	skipPreDeployJobs: boolean;
	image: { reference: string /* …@sha256:<64 hex> */; pull?: { server: string; username: string; password: string } };
	components: AppComponentInput[];
	jobs: AppJobInput[];
	cron: AppCronInput[];
	smoke: AppSmokeInput[];
	env: { values: Record<string, string>; checksum: string; secretNames: string[] /* for redaction */ };
	hosts: { primary: string | null; extra: string[]; previous: string[] };
	ingress: {
		className: string | null;
		controllerNamespace: string | null;
		tls: 'cert-manager' | 'external' | 'none' | 'edge';
		issuer: string | null;
	};
	network: { isolation: boolean; extraEgress: Array<{ cidr: string; ports: number[] }>; needsHairpin: boolean };
	policy: {
		podSecurity: 'restricted' | 'baseline';
		allowRoot: boolean;
		runtimeClassName: string | null;
		quota: AppQuotaInput | null;
		limitRange: AppLimitRangeInput;
		cronMinIntervalMinutes: number;
		scaleFailedFirstDeployToZero: boolean;
		requireIsolationEnforced: boolean;
	};
	preview?: { prNumber: number };
}

export interface AppDeployHooks {
	onPhase(phase: AppDeployPhase, detail?: Record<string, unknown>): Promise<void>;
	verifyPublic(req: { urls: string[]; checks: AppSmokeInput[]; windowSeconds: number }): Promise<AppSmokeRun>;
	isCancelled(): Promise<boolean>;
}

export interface AppDeployResult {
	outcome: 'succeeded' | 'succeeded-with-warnings' | 'failed' | 'rolled-back' | 'cancelled' | 'rollback-failed';
	/** Required when the outcome is 'cancelled', or 'rolled-back' because of a cancel (§3.1). */
	cancelReason?: 'user' | 'quarantined' | 'app_work_deleting';
	image?: { reference: string; digest: string; resolvedFromTag: boolean }; // §5.8, strategy `image` only
	failure?: { phase: AppDeployPhase; code: AppFailureCode; message: string; logRef?: AppLogRef };
	warnings: Array<{ code: string; message: string }>;
	components: AppComponentStatus[];
	jobs: AppJobResult[];
	smoke: AppSmokeResult;
	ingressAddress: { ip?: string; hostname?: string } | null;
	isolationEnforced: boolean | null;
	firstDeployJobsCompleted: boolean;
}

export interface IDeploymentPluginAppMembers {
	// merged into IDeploymentPlugin
	readonly supportsApps?: boolean; // C
	deployApp?(input: AppRenderInput, credential: string, hooks: AppDeployHooks): Promise<AppDeployResult>; // C
	getAppStatus?(ref: AppTargetRef, credential: string, spec: AppStatusSpec): Promise<AppStatusSnapshot>; // C
	runAppJob?(ref: AppTargetRef, credential: string, job: AppJobRunRequest): Promise<AppJobResult>; // C
	destroyApp?(ref: AppTargetRef, credential: string, opts: { deleteVolumes: boolean }): Promise<AppDestroyResult>; // C
	scaleApp?(
		ref: AppTargetRef,
		credential: string,
		mode: 'pause' | 'resume',
		replicas: Record<string, number>,
		resumeChecks?: { smoke: AppSmokeInput[]; deadlines: Record<string, number> }
	): Promise<AppScaleResult>; // C (added; returns AppScaleResult, §3.1)
	getAppLogs?(ref: AppTargetRef, credential: string, req: AppLogRequest): Promise<AppLogTail>; // C (added)
	checkAppCluster?(credential: string, req: AppClusterCheckRequest): Promise<AppClusterCheck>; // C (added)
	/**
	 * Namespace preparation for dependency provisioning (added, GAP-06 / APW-07).
	 * Idempotent. Applies the namespace (ownership check and pod-security labels), the ServiceAccount, the
	 * LimitRange (403 → warning `limitrange_forbidden`) and — when `isolation` is true — the three baseline
	 * policies `ew-default-deny`, `ew-allow-same-namespace` and `ew-allow-egress`. It never draws
	 * `ew-allow-ingress` or `ew-allow-deps`, which only a Deployment draws, and never touches a `dep-*` policy.
	 */
	prepareAppNamespace?(
		ref: AppTargetRef,
		credential: string,
		opts: { isolation: boolean; limitRange: AppLimitRangeInput }
	): Promise<{ warnings: Array<{ code: string; message: string }> }>; // C (added)
	/**
	 * Re-applies only the Ingress for the given hosts (added). Used by the `ingress-reconcile` op, which must
	 * never call `deployApp`. Returns the ingress address it observed.
	 */
	publishAppHosts?(
		ref: AppTargetRef,
		credential: string,
		hosts: { primary: string | null; extra: string[]; previous: string[]; tls: string; issuer: string | null }
	): Promise<{ ingressAddress: { ip?: string; hostname?: string } | null }>; // C (added)
}
```

`destroyApp` never deletes a `PersistentVolumeClaim` or anything labelled `ever-works.io/dependency` unless
`deleteVolumes: true`; dependency deprovisioning itself is APW-07's (`IAppDependencyProvider.deprovision`) and is
called by the platform **before** `destroyApp(…, { deleteVolumes: true })`. With `deleteVolumes: false` it also keeps the
`ew-default-deny` policy whenever an object labelled `ever-works.io/dependency` or a PVC remains (spec FR-50), and
returns `kept: [{ kind, name }]` in `AppDestroyResult`. For `ref` of a verification namespace (label
`ever-works.io/purpose: verification`) it deletes the whole namespace regardless of `deleteVolumes` (R-10).

**Ever Works Apps (R-5).** The same optional members are implemented for that target by APW-10's `ever-works-apps`
plugin (capabilities `apps-tier` + `deployment`): `deployApp` maps the render input to desired state and writes it
through the control-namespace credential that `AppsTierPolicy.resolveClusterCredential(workId)` returns; `destroyApp` →
`removeWork` with the same `deleteVolumes` rule. The `k8s` plugin never receives that credential and never applies
anything for `ever-works-apps`.

### 3.1 Type reference (normative) — added 2026-09-17

T2 creates the types of §3 **and this section**. Inputs **alias APW-03's App-spec types** (R-1) and never redefine
them; only the resolved fields below are this epic's. Everything here is what APW-04, APW-10 and APW-13 compile
against, so a field named here is a contract.

- `AppComponentInput` = APW-03's `AppSpecComponent` with defaults resolved (schema §10), plus
  `{ primary: boolean; deadlineSeconds: number /* §5.3 */; internalUrl: string }`.
- `AppJobInput` = APW-03's `AppSpecJob` with `component` resolved (schema §13).
- `AppCronInput` = APW-03's `AppSpecCron` (schema §14).
- `AppSmokeInput` = APW-03's `AppSpecSmoke` with `name` and `component` resolved (schema §16).
- `AppQuotaInput` — the 13 keys of §4.2 as quantity strings/ints.
  `AppLimitRangeInput = { defaultRequest: { cpu, memory }, defaultLimit: { cpu, memory, ephemeralStorage },
max: { cpu, memory } }`.
- `CheckResult = { name, status: 'passed'|'failed'|'skipped', httpStatus?: number, latencyMs?: number,
failedExpectation?: string, found?: string /* ≤ 200 chars, secret-scrubbed */,
classification?: 'dns_not_pointing'|'tls_not_ready'|'unreachable'|'check_failed' }` (§4.8, §5.5).
- `AppSmokeRun = { checks: CheckResult[]; passed: boolean }` (what `hooks.verifyPublic` resolves to).
- `AppSmokeResult = { inCluster: CheckResult[]; public: CheckResult[]; hairpin?: CheckResult; observedAt: string }`.
- `AppComponentStatus = { name, role: 'web'|'worker', desired, ready, restarts, lastTerminationReason?,
oomKilledAt?: string|null }`.
- `AppJobResult = { name, when, runName, status: 'succeeded'|'failed'|'timeout'|'running', startedAt,
completedAt?, exitCode?, http?: CheckResult, logRef?: AppLogRef }`.
- `AppJobRunRequest = { name, image: string, confirmFirstDeploy?: boolean, runner?: 'smoke',
checks?: AppSmokeInput[] }`.
- `AppLogRef = { component?: string, job?: string, pod: string, container: string, previous: boolean }`.
- `AppLogRequest = { component?, job?, deploymentId?, previous?: boolean, lines: number /* 1–500, default 200 */,
secretValues: Record<string, string> /* in memory, redaction only — never logged, never stored */ }`.
- `AppLogTail = { containers: Array<{ pod, container, lines: string[], truncated: boolean }>,
redactedNames: string[], fetchedAt }` (FR-48 limits).
- `AppStatusSpec = { components: Array<{ name, role, replicas, primary }>, jobs: string[], cron: string[] }`.
- `AppStatusSnapshot = { observedAt, components: AppComponentStatus[], jobs: Array<{ name, last?: AppJobResult }>,
cron: Array<{ name, lastScheduleAt?, lastSuccessAt?, lastResult? }>, smoke?: AppSmokeResult,
isolationEnforced: boolean|null, ingressAddress?: { ip?, hostname? }|null }`. For a verification ref only
  components, jobs and smoke are set (§4.12).
- `AppClusterCheckRequest = { namespace: string|null, needsCreateNamespace: boolean }`.
- `AppClusterCheck = { ok: boolean, serverVersion?, fingerprint, missingPermissions: Array<{ verb, resource }>,
optionalMissing: Array<{ verb, resource }>, ingressClasses: Array<{ name, isDefault }>,
controllerNamespace: string|null, clusterIssuers: string[], storageClasses: Array<{ name, isDefault }>,
error?: { code, message } }` (§6.3, secret-free). The `clusterFingerprint` column stays the **deployed**
  cluster written by §5.6; the fingerprint a check observes lives **inside** `clusterCheck` (§9.10).
- `AppDestroyResult = { deleted: Array<{ kind, name }>, kept: Array<{ kind, name }>, namespaceDeleted: boolean }`.
- `AppScaleResult = { components: AppComponentStatus[], smoke: AppSmokeRun|null,
failure?: { code: AppFailureCode; message: string } }` — what `scaleApp('resume', …, resumeChecks)` resolves
  to after the phase-3 rollout wait and the phase-5 in-cluster smoke (§9.10).
- `AppRuntimeState = 'not-deployed'|'live'|'degraded'|'down'|'unreachable'|'paused'|'deleting'` — the app state
  FR-46 reports, mapped from `health` + `paused` + `removedAt` + `deletionRequestedAt`. `Deploying` and
  `Live with warnings` are the **current Deployment's** states and are shown beside it, never instead of it.
- `AppFailureCode` — one union collecting §5.4, §11 and §10.3: `crash_loop`, `oom_killed`, `image_pull`,
  `create_container_config`, `rollout_timeout`, `job_failed`, `smoke_failed`, `publish_failed`,
  `rollback_failed`, `cluster_unreachable`, `worker_failed`, `isolation_not_enforced`,
  `managed_root_forbidden`, `image_user_unverifiable`, `deadline_exceeded`, `image_not_found`,
  `image_private_unsupported`, `image_unresolvable`. T1's `APP_FAILURE_CODES` pins exactly this list.
- `AppPrecondition` — unchanged: `{ code, names?, message, fixUrl? }`.

---

## 4. The App renderer (`packages/plugins/k8s/src/app/`)

Pure functions from `AppRenderInput` to manifests; no I/O. The existing `manifest.renderer.ts` is not edited.

### 4.1 Names and labels — `app-names.ts` _(new)_

| Object                         | Name                                                                                                 | Notes                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Namespace                      | `ew-<slug ≤ 30>-<first 8 hex of workId>`                                                             | Computed once, persisted in runtime state; **frozen at the first `prepare-namespace` — dependency provisioning or first Deployment, whichever comes first** (§9.10, GAP-06); preview: `<ns>-pr<number>`; verification: `<ns>-v<first 6 hex of provisioningId>-<attempt ≤ 9>` (R-10, §4.12). |
| ServiceAccount                 | `app`                                                                                                | `automountServiceAccountToken: false`.                                                                                                                                                                                                                                                      |
| Deployment / Service / Ingress | `<component>`                                                                                        | App spec `Name` is 1–32 chars (APW-03 schema §0).                                                                                                                                                                                                                                           |
| Env Secret                     | `app-env-<checksum first 10 hex>`                                                                    | `immutable: true`; keys are exactly the App spec's runtime env names.                                                                                                                                                                                                                       |
| Platform ConfigMap             | `app-platform-<checksum first 10 hex>`                                                               | `immutable: true`; the non-secret `EVER_WORKS_*` variables (§4.7).                                                                                                                                                                                                                          |
| Pull Secret                    | `app-pull`                                                                                           | Mutable (token rotation).                                                                                                                                                                                                                                                                   |
| Job                            | `job-<name>-<deploymentShort>`                                                                       | ≤ 45 chars. Manual run: `run-<name>-<8 hex>`.                                                                                                                                                                                                                                               |
| CronJob                        | `cron-<name>`                                                                                        | ≤ 37 chars (< 52 limit).                                                                                                                                                                                                                                                                    |
| PVC                            | `<component>-<volume>`                                                                               | Label `ever-works.io/retain: "true"`.                                                                                                                                                                                                                                                       |
| Probe/runner ConfigMap         | `ew-runner-<hash10>`                                                                                 | Script + check list.                                                                                                                                                                                                                                                                        |
| NetworkPolicies                | `ew-default-deny`, `ew-allow-same-namespace`, `ew-allow-ingress`, `ew-allow-egress`, `ew-allow-deps` | The first three are the **baseline** a `prepare-namespace` op draws before any dependency is provisioned; `ew-allow-ingress` and `ew-allow-deps` are drawn only by a Deployment.                                                                                                            |
| LimitRange / ResourceQuota     | `ew-defaults` / `ew-quota`                                                                           |                                                                                                                                                                                                                                                                                             |
| Dependency NetworkPolicy       | `dep-<kind>`                                                                                         | Drawn by APW-07's provider before its own workload, never by this renderer; labelled `ever-works.io/dependency: <kind>`.                                                                                                                                                                    |

Labels on every object: `app.kubernetes.io/managed-by: ever-works-k8s-plugin`, `app.kubernetes.io/part-of:
<slug>`, `ever-works.io/work-id: <Work uuid>`, `ever-works.io/kind: app`, and `ever-works.io/component` /
`ever-works.io/job` / `ever-works.io/cron` where relevant. **Not** `ever-works.io/managed` and **not**
`app.kubernetes.io/name` (§1.2 #6). Selectors: `{ ever-works.io/component: <name> }` — stable across slug
renames. Namespace labels add `pod-security.kubernetes.io/enforce|warn|audit` (§4.4); verification namespaces add
label `ever-works.io/purpose: verification` and annotation `ever-works.io/expires-at: <RFC 3339 UTC>`.

### 4.2 Namespace-scoped objects — `app-manifest.renderer.ts` _(new)_

Apply order in `prepare`: Namespace (or verify pre-created) → ServiceAccount → LimitRange (skip on 403 for
`your-cluster`, warning `limitrange_forbidden`) → ResourceQuota (`ever-works-apps` only; 403 is fatal) →
NetworkPolicies → pull Secret → env Secret → PVCs → Services. Namespace ownership check: an existing namespace
must carry `ever-works.io/work-id` equal to this Work, or be the owner-selected pre-created namespace with no
object labelled for another Work.

**Namespace and baseline policies before anything else (added — breaks the GAP-06 / APW07-G01 cycle).** The
`prepare-namespace` op (§9.10) calls the **same** renderer in this order, and it is the single ordering the whole
program uses:

1. Namespace: ownership check, `ever-works.io/work-id` label, the pod-security labels of §4.4, the verification
   purpose label and expiry annotation when the ref is a verification ref.
2. ServiceAccount `app`.
3. LimitRange `ew-defaults` (403 on `your-cluster` is the warning `limitrange_forbidden`).
4. When `isolation` is true: `ew-default-deny`, `ew-allow-same-namespace` and `ew-allow-egress` (DNS and
   internet only). `ew-allow-ingress` and `ew-allow-deps` are **not** drawn here — a Deployment draws them, and
   until one runs there is nothing to publish or to depend on.
5. `ResourceQuota` on `ever-works-apps` only.

The op persists `namespace` and `clusterFingerprint` and is idempotent; `deployApp`'s `prepare` re-applies the
same objects and is the only place that adds the remaining two policies. Because the namespace and the baseline
policies now exist **before** either a dependency is provisioned or a Deployment starts, APW-07's providers
never wait for a Deployment and a Deployment still waits for ready dependencies (FR-24) — the cycle is broken by
sequence alone, and no requirement is dropped.

`LimitRange` defaults (both targets): default request 100m / 128Mi, default limit 1 CPU / 512Mi,
ephemeral-storage default limit 1Gi; `max` per container 8 CPU / 64Gi on `your-cluster`, 2 CPU / 4Gi on
`ever-works-apps`. `ResourceQuota` (`ever-works-apps`, from `AppsTierPolicy`, defaults): `requests.cpu: 2`,
`limits.cpu: 4`, `requests.memory: 4Gi`, `limits.memory: 6Gi`, `pods: 20`, `persistentvolumeclaims: 5`,
`requests.storage: 20Gi`, `services.loadbalancers: 0`, `services.nodeports: 0`, `count/jobs.batch: 20`,
`count/cronjobs.batch: 20`, `secrets: 30`, `configmaps: 30`.

### 4.3 Workloads

Per component a `Deployment`:

- `replicas` from spec; `revisionHistoryLimit: 5`; `progressDeadlineSeconds` = the component deadline (§5.3).
- Strategy: `Recreate` when the component has volumes; else `RollingUpdate` with `maxSurge: 0, maxUnavailable: 1`
  for 1 replica and `maxSurge: 1, maxUnavailable: 0` above (same trade-off the site renderer documents).
- `minReadySeconds: 30` for workers without probes; `0` otherwise.
- Pod template annotations: `ever-works.io/env-checksum`, `ever-works.io/build-commit`. Env via
  `envFrom: [{ secretRef: { name: app-env-…, optional: false } }, { configMapRef: { name: app-platform-…, optional: false } }]` — **not optional**: a missing Secret must fail
  loudly (`CreateContainerConfigError`), unlike the site path. No env value is ever written into a Deployment,
  Job or CronJob spec (ACCEPTANCE E2E-05).
- **No per-Deployment value ever reaches a pod template (added — APW06-G07).** `ever-works.io/deployment-id`
  goes on the `Deployment` object's `metadata.annotations`, **never** on `spec.template`. No per-Deployment
  value (deployment id, `deploymentShort`, timestamp, revision counter) is written into a component pod
  template, a CronJob `jobTemplate`, the env Secret or the platform ConfigMap. Images are digest-pinned, so a
  new Build changes the template by itself. A Deployment with the same Build, env checksum and spec renders
  byte-identical templates, so Kubernetes creates no new ReplicaSet and no pod restarts (FR-17). This differs
  on purpose from the site path's `ever-works.io/revision`, which exists only because that path deploys a
  mutable tag. Per-Deployment objects — the Jobs named `job-<name>-<deploymentShort>` — may still carry the id.
- `enableServiceLinks: false`, `automountServiceAccountToken: false`, `serviceAccountName: app`,
  `imagePullSecrets` when `image.pull` is set, soft hostname `topologySpreadConstraints` (as today),
  `runtimeClassName` when the policy names one.
- Container `command`/`args` from spec; `ports` for web components only; `imagePullPolicy: IfNotPresent`
  (digest-pinned references make `Always` pointless).

Web components get a `ClusterIP` Service `port 80 → targetPort <spec port>`. Only `domains.primaryComponent`
gets an `Ingress`. The reference `components.<name>.internalUrl` (CONTRACTS §1, APW-13 addition) resolves to
`http://<name>.<namespace>.svc.cluster.local` — known before rendering because the namespace is fixed first — and
`build.commitSha` to the Build's 40-character commit; both are passed to `AppRuntimeEnvSource` (§9.6).

### 4.4 Security context — `app-security.ts` _(new)_

The `ever-works-apps` column is what this renderer produces when APW-10's in-zone controller calls it; the zone then
applies its own non-overridable overlays (runtime class, token, labels) — the platform applies none of it (R-5).

| Field                                 | `your-cluster`                                                                 | `ever-works-apps` (rendered in-zone)                   |
| ------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| pod `runAsNonRoot`                    | `true`; `false` when `allowRoot`                                               | `true` always                                          |
| pod `seccompProfile`                  | `RuntimeDefault`                                                               | `RuntimeDefault`                                       |
| pod `fsGroup` / `fsGroupChangePolicy` | `10001` / `OnRootMismatch` when volumes                                        | same                                                   |
| container `allowPrivilegeEscalation`  | `false`                                                                        | `false`                                                |
| container `capabilities`              | `drop: [ALL]`; `add: [NET_BIND_SERVICE]` only when `allowRoot` and port < 1024 | `drop: [ALL]`; port < 1024 refused (`privileged_port`) |
| container `readOnlyRootFilesystem`    | `!writableRootFilesystem`                                                      | `!writableRootFilesystem`                              |
| `/tmp` emptyDir (`sizeLimit: 256Mi`)  | when read-only                                                                 | when read-only                                         |
| namespace pod security                | enforce `baseline`, warn+audit `restricted`                                    | enforce `restricted`                                   |

> **`runAsUser` — the one field that can rescue a named-user image (added 2026-09-17, gap APW06-G26).** The table
> above pins `runAsNonRoot: true` on both targets (`true` always on `ever-works-apps`), and the classifier below maps
> the kubelet's `image has non-numeric user` to `image_user_unverifiable`. An image whose `USER` is a **name** —
> Umami's is `nextjs` — therefore fails on **both** targets with **no input the App author could set**, because
> APW-03's `components` had no numeric-user field. Closed additively: **APW-03 `schema.md` §10 gains an optional
> `components[].runAsUser` (integer, 1…4294967294, no default; validator rule R27)**, and the renderer passes it
> through **verbatim** — `packages/plugins/k8s/src/app/app-security.ts`'s optional `runAsUser` seam **never derives**
> a uid, and emits nothing when the field is absent, so every existing App spec renders byte-identically. On
> `ever-works-apps` the field is allowed and the zone's own `restricted` policy still applies on top.

Rollout classifier (§5.4) maps kubelet messages `container has runAsNonRoot and image will run as root` and
`image has non-numeric user` to **`managed_root_forbidden`** / `image_user_unverifiable` within 180 s. (The
classifier line previously named `image_runs_as_root`, which is **not** in §3.1's `AppFailureCode` union and is not a
precondition code either — it is the camelCase **i18n leaf** `failures.imageRunsAsRoot`, whose code is
`managed_root_forbidden`, per §10.3 and the `AppImageConfigReader` preconditions in §5.1. The union is the
authority: `image_runs_as_root` was never a code, so nothing is added, removed or renamed here — the prose now names
the code that actually exists, which is what T9's classifier has to return.) For
`ever-works-apps` the refusal happens **before apply**: `AppImageConfigReader` _(new,
`packages/agent/src/app-runtime/app-image-config.reader.ts`)_ reads the image config's `User` from the registry in
the worker (manifest → `linux/amd64` entry of an index → config blob; pull credential from APW-05; 10 s timeout;
registry host passes the public-address guard of §6.1). Empty, `0`, `root`, `0:*` or a non-numeric user →
precondition `managed_root_forbidden` / `image_user_unverifiable`. On `your-cluster` the same read only pre-warns.

### 4.5 Probes and resources

Probe object (APW-03 §10) → `httpGet { path, port: 'http' }` or `tcpSocket { port: 'http' }` with
`periodSeconds`, `timeoutSeconds`, `initialDelaySeconds`, `failureThreshold`. Defaults applied by the renderer
only where the spec is silent: web startup `tcpSocket`, period 10 s, `failureThreshold: 60`. Liveness only when
declared. Resources: `requests.cpu = resources.cpu`, `requests.memory = resources.memory`,
`limits.memory = resources.memoryLimit`, `limits.cpu = resources.cpuLimit` when declared; on `ever-works-apps`
an absent `cpuLimit` becomes `max(1, 4 × cpu)` so the quota admits the pod.

### 4.6 Volumes

`PersistentVolumeClaim { accessModes: [ReadWriteOnce], resources.requests.storage: size, storageClassName:
<target setting or cluster default> }`, annotation `ever-works.io/backup: "true|false"`. Mounted at `path`.
SSA only ever raises `storage`; a lower value is refused before apply (`volume_shrink`). `replicas > 1` with
volumes is refused (`volume_replicas`) — see spec §9.

### 4.7 Env and pull Secrets

The env Secret holds exactly the `values` from `AppRuntimeEnvSource` (APW-07, runtime/both phases). The platform
ConfigMap holds `EVER_WORKS_APP_URL`, `EVER_WORKS_APP_HOST`, `EVER_WORKS_APP_COMMIT` and
`EVER_WORKS_SOURCE_URL` (FR-44 only) — none secret; collision with an App spec name is impossible (APW-03 R23).
**Added (APW06-G07): `EVER_WORKS_DEPLOYMENT_ID` is not injected.** The checksum still covers both maps, but
every value in either map now depends only on the Build, the env values and the published hosts — nothing is
per-Deployment, because the checksum names **immutable** objects: `app-env-<checksum>` and
`app-platform-<checksum>`. Keeping the id in a checksum-named immutable ConfigMap would need two contents under
one name and leave a pod that was not restarted reading a stale id, so the id is not in the map at all.
`checksum` = first 16 hex of sha256 over `name=value` lines of both maps sorted by name (the `hashRuntimeEnv`
form). After a successful Deployment, env Secrets and platform ConfigMaps not referenced by the current or 2
previous ReplicaSets of any component are deleted.

### 4.8 Jobs and the runner — `app-jobs.renderer.ts`, `app-runner.script.ts` _(new)_

- `command` jobs: `Job` with the component's image, env, security context and resources;
  `backoffLimit: retries`, `activeDeadlineSeconds: timeoutSeconds`, `ttlSecondsAfterFinished: 86400`,
  `restartPolicy: Never`. The last 3 Jobs per job name are kept.
- `http` jobs, `http` cron and every smoke run use the **runner**: a `Job` on a digest-pinned public Node.js
  runtime image (`APP_RUNNER_IMAGE` constant, reviewed on bump) that executes `app-runner.script.ts` mounted
  read-only from a ConfigMap, reading the request list from a second mounted file. **Paths, bodies and
  expectations are data read with `JSON.parse`, never interpolated into a command line.** Requests use
  `redirect: 'manual'` — smoke, job and cron requests never follow redirects, so `expect.status` judges the first
  response (CONTRACTS §1). `http.authEnv` is sent as `Authorization: Bearer <value>` (`authScheme: bearer`,
  default) or `Authorization: <value>` (`authScheme: raw`, APW-13 addition), for jobs and cron alike. Bodies with
  `{{env.NAME}}` placeholders are resolved by the runner from `secretKeyRef` env vars; the resolved body is
  never logged. Output: one JSON line per request `{ name, status, latencyMs, failedExpectation?, found? }`,
  `found` truncated to 200 characters and scrubbed of every mounted secret value.
- Runner hardening: same security context as §4.4 (non-root numeric user `10001`, read-only root, no token),
  requests 50m / 64Mi, limits 500m / 128Mi, `activeDeadlineSeconds` = window + 30.

### 4.9 CronJobs

`CronJob { schedule, timeZone: 'Etc/UTC', concurrencyPolicy: Forbid|Allow (spec concurrency, default Forbid),
startingDeadlineSeconds: 300, successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 3, suspend: paused }`.
`http` cron → runner job targeting `http://<component>.<ns>.svc:80<path>` with the `Authorization` header built
per `authScheme` from a `secretKeyRef` of `authEnv`. A cron whose `authEnv` value is unset or empty is a precondition failure
(`cron_auth_env_unset`), never a rendered call without a credential. On `ever-works-apps`, schedules that can
fire more often than every 5 minutes are refused (`cron_too_frequent`).

### 4.10 Network policies — `app-network-policy.renderer.ts` _(new)_

| Policy                    | Selector / rule                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ew-default-deny`         | all pods; `policyTypes: [Ingress, Egress]`, no rules.                                                                                                                                                                                                                                                                  |
| `ew-allow-same-namespace` | ingress + egress to `podSelector: {}` in the namespace.                                                                                                                                                                                                                                                                |
| `ew-allow-ingress`        | primary web component pods; from `namespaceSelector: kubernetes.io/metadata.name=<controllerNamespace>`; when unknown, from `namespaceSelector: {}` on the web port only (warning `ingress_controller_namespace_unknown`).                                                                                             |
| `ew-allow-egress`         | UDP+TCP 53 to `kube-system` pods `k8s-app=kube-dns` (fallback: any namespace, port 53); `0.0.0.0/0` except `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `169.254.0.0/16`, `127.0.0.0/8`, `0.0.0.0/8`, `224.0.0.0/4`, `240.0.0.0/4`; `::/0` except `fc00::/7`, `fe80::/10`, `::1/128`, `ff00::/8`. |
| `ew-allow-deps`           | `extraEgress` CIDRs/ports (dependencies outside the namespace, resolved by the platform at render time) and, when `needsHairpin`, the ingress address on 80/443.                                                                                                                                                       |

When `isolation: false` (your-cluster opt-out) none of the five policies is rendered, and existing policies with
these names are deleted. **Added (APW07-G01): the deletion set is exactly those five `ew-*` names and never a
`dep-<kind>` NetworkPolicy**, which APW-07's providers own, carry `ever-works.io/dependency: <kind>` and keep
whatever the App Work's isolation setting — that is what makes FR-38 (a dependency reachable only from the App
Work's own pods) hold even with isolation off. Enforcement probe (after rollout): the runner opens a
TCP connection to `kubernetes.default.svc:443` with a 3 s timeout; connected ⇒ `isolationEnforced: false`.
The three baseline policies (`ew-default-deny`, `ew-allow-same-namespace`, `ew-allow-egress`) are also drawn by the
`prepare-namespace` op before any dependency is provisioned (§4.2), so `isolation: false` means zero `ew-*`
policies from either path while `dep-<kind>` still exists.

**Enforcement probe that cannot report a false "Not enforced" (rewritten 2026-09-17, APW06-G18).** Connecting to
`kubernetes.default.svc:443` was unreliable: FR-4 makes a **public** API-server address the supported case, and
`ew-allow-egress` permits `0.0.0.0/0` except private ranges, so on such a cluster the connection succeeds even when
NetworkPolicy **is** enforced — a false **Not enforced by your cluster's network plugin**, and on Ever Works Apps a
failed Deployment. The probe now measures a destination the rendered policies must deny on every cluster:

- The policy-level `spec.podSelector` of `ew-allow-same-namespace`, `ew-allow-egress` and `ew-allow-deps` becomes
  `{ matchExpressions: [{ key: ever-works.io/isolation-probe, operator: DoesNotExist }] }`, so a pod carrying that
  label is selected **only** by `ew-default-deny` and has no egress at all — not even DNS. Their **peer** selectors
  stay `podSelector: {}`, `ew-default-deny` keeps `{}` and `ew-allow-ingress` is unchanged. The label only removes
  allowances, so a pod that carries it gains nothing.
- `renderRunnerJob('isolation-probe')` runs in the app (or verification) namespace with that label and connects to
  `$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT` with a 3 s timeout. The kubelet sets both variables even with
  `enableServiceLinks: false`, so no name lookup is needed. Connected ⇒ `isolationEnforced: false`; timeout, refusal
  or unreachable ⇒ `true`; a probe Job that does not report within its `activeDeadlineSeconds` ⇒ `null` with warning
  `isolation_probe_inconclusive`, **never** `true`. With `isolation: false` no probe runs and the value is `null`.
- The result therefore does not depend on whether the API server's endpoints are public (FR-4) or private. The kind
  lane (T15) asserts the value against the CNI the workflow actually runs and **names that CNI in the spec**, rather
  than assuming kindnet ignores NetworkPolicy — newer kind releases may enforce it, and then `true` is correct.
  **A listener pod as the probe target is explicitly not adopted:** with the exclusion on a peer selector the
  target's own ingress stays allowed, `ew-allow-egress` can still admit the connection, and a listener that is not yet
  listening would produce a second false "Enforced".

### 4.11 Ingress, TLS, published hosts

`Ingress` for the primary web component with rules for `hosts.primary ∪ hosts.extra ∪ hosts.previous` (previous
hosts kept until a `rebuild`-policy Deployment succeeds), `ingressClassName`, strategy annotations from the
existing registry, TLS block only for `tls: 'cert-manager'` (issuer annotation) — `external` and `none` render no
TLS; `edge` (managed) follows `AppsTierPolicy`. Every host passes the strict RFC-1123 check used by
`addDomain`. No `Ingress` is rendered when no class exists and no default class was detected (warning
`no_ingress_controller`, public smoke skipped).

**URL scheme per TLS mode (spec FR-41, FR-42).** `appUrlScheme(tls, hostKind)` in `app-hosts.service.ts`:
`cert-manager` → `https` for every host (TLS block lists every host, issuer annotation from `ingress.issuer`);
`external` → `https` for custom domains and `http` for the managed subdomain (its record points straight at the
ingress, so no outside terminator exists), no certificate requested; `none` → `http`, warning `tls_disabled`; `edge`
(Ever Works Apps) → `https`. `EVER_WORKS_APP_URL`, `domains.primary.url` handed to APW-07, the Deploy tab URL and the
public smoke URLs all use this one function.

**Self-address (hairpin) check (spec FR-37).** When `network.needsHairpin` is true, `app-deployer.ts` renders
`renderRunnerJob('hairpin')` after publish: a runner Job **inside the app namespace** that requests the first smoke check
against `<scheme>://<primary host><path>` resolved by cluster DNS (no `Host` override), with the egress to the ingress
address allowed by `ew-allow-deps`. Its result is `smokeResult.hairpin`; failure is warning
`hairpin_unreachable` ("Your app can't reach its own address from inside the cluster") and never a rollback. No hairpin
Job is rendered when `needsHairpin` is false or there is no primary host.

### 4.12 Verification targets — `purpose: 'verification'` (Resolution R-10)

Requested by APW-04 through `app-cluster-op` ops `verification-deploy`, `verification-status`,
`verification-destroy` (§9.2), on the isolated worker, `your-cluster` only:

- **Namespace** `<ns>-v<first 6 hex of provisioningId>-<attempt ≤ 9>` — **this epic derives and owns the name**:
  `<ns>` is the live namespace name from §4.1 (`ew-<slug ≤ 30>-<first 8 hex of workId>`), so `verification-deploy`
  **returns** it and `verification-destroy` takes it back as a handle. The provisioning part stops a
  re-provision's attempt 1 from colliding with a leftover or still-`Terminating` namespace from an earlier run;
  the whole name stays within 52 characters (63 is the hard cap). APW-04 must **never** derive or hard-code a
  verification namespace name of its own (an earlier draft used `ewv-<work short id>-<attempt>`, which would have
  had APW-04 destroying a namespace APW-06 never created). With the purpose label and expiry annotation
  `now + ttlMinutes` (1–240); never the live namespace, never recorded in `work_app_runtime_states.namespace`,
  never a `WorkDeployment` row.
- **Rendered**: ServiceAccount, LimitRange, the three baseline NetworkPolicies, pull Secret, env Secret from
  APW-07's ephemeral mode (values in memory only), the `dep-<kind>` policies APW-07's ephemeral providers draw,
  Deployments and Services, `pre-deploy` / `first-deploy` Jobs. **Not rendered**: Ingress, TLS, CronJobs, DNS
  records, custom domains, PVCs — every volume becomes an `emptyDir` with the declared size as `sizeLimit`.
- **Dependencies**: `verification-deploy` applies the namespace and its policies first, then calls
  `AppDependenciesService.provisionEphemeral(workId, <verification namespace>, kinds)` (APW-07 §4.9,
  `ephemeral: true` — no PVC, outputs returned in memory and never stored — added by GAP-06 / APW06-G08), and
  only then renders the workloads. APW-07 is reached through a typed fake until it lands.
- **Smoke** runs only in-cluster with the runner (`renderRunnerJob('smoke')`, `Host: <component>.<ns>.svc`), no public
  smoke and no hairpin check; the isolation probe result is reported, never fatal.
- **Destroy** deletes the namespace (propagation `Foreground`) and waits ≤ 300 s; the expiry annotation lets APW-04's
  `app-provision-sweep` destroy leftovers. `getAppStatus` for a verification ref returns components, jobs and smoke only.
- **Result channel (added, APW06-G09).** Results do not land in a `WorkDeployment` row, so the worker calls the
  port `AppVerificationSink.report(update)` (§9.6) on every `onPhase`, at the end, on `verification-status` and
  after destroy; APW-04's `AppProvisioningService` implements it and stores `attempts[n]`,
  `verificationNamespace` and `verificationExpiresAt` on its own row. The default binding throws
  `verification_sink_unavailable` before any namespace is created, so a verification can never run with nowhere
  to report.

---

## 5. Deploy orchestration

### 5.1 Preconditions — `packages/agent/src/app-runtime/app-deploy-preconditions.service.ts` _(new)_

Returns `AppPrecondition[]` (`{ code, names?, message, fixUrl? }`), never throws for an unmet one.

| Code                                                                                          | Source                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec_invalid`                                                                                | APW-03 validator over `.works/works.yml` **at the Build's commit** (Git facade read).                                                                                                                                |
| `license_blocks_target` / `license_attestation_missing`                                       | `AppLicenseService.getHostingEligibility(workId)` (APW-03, R-3; table in §5.2).                                                                                                                                      |
| `env_required_unset`                                                                          | `AppRuntimeEnvSource.resolve(...).unsetRequired`.                                                                                                                                                                    |
| `dependency_not_ready`                                                                        | `AppDependenciesService.ensureReadyForDeploy(workId).notReady` (added, GAP-05) — it also dispatches provisioning for `pending` kinds; the §5.6 step 1 re-check keeps `resolve().notReadyDependencies`.               |
| `no_green_build` / `no_green_build_for_head` (+ `latestGreenBuildId`) / `build_image_missing` | `WorkBuild` (APW-05). **`build.strategy: dockerfile` and `auto` only** (§5.8).                                                                                                                                       |
| `nothing_to_deploy` (added)                                                                   | effective spec `build.strategy: none` — Builds still run, but there is no image to run.                                                                                                                              |
| `image_not_pinned` (added; worker-side on `ever-works-apps`)                                  | §5.8: a tag-only `build.image` reference.                                                                                                                                                                            |
| `image_not_found` / `image_private_unsupported` / `image_unresolvable` (added, worker-side)   | §5.8 registry answers 404 / 401-403 / timeout.                                                                                                                                                                       |
| `primary_domain_missing` (added, GAP-09)                                                      | entries whose source is `domains.primary.*` while no primary host exists (S33 / no apps domain): names them, and the in-cluster URL is used with warning `primary_url_incluster` instead of refusing the Deployment. |
| `target_none` / `target_not_checked` / `cluster_changed_unconfirmed`                          | runtime state.                                                                                                                                                                                                       |
| `managed_disabled` / `managed_scope_unverified_blueprint` / `quota_exceeded`                  | `AppsTierPolicy.isOpen()` / `managedScope()`, `EverWorksAppsQuotaService`.                                                                                                                                           |
| `managed_ineligible` (+ reasons) / `managed_sandbox_unavailable`                              | `AppsTierPolicy.eligibility(userId)`; `podPolicy().runtimeClassName === null` (R-24).                                                                                                                                |
| `app_work_deleting`                                                                           | runtime state `deletionRequestedAt` set (§9.7).                                                                                                                                                                      |
| `paused` / `deploy_in_progress`                                                               | runtime state.                                                                                                                                                                                                       |
| `cron_auth_env_unset` / `job_auth_env_unset`                                                  | env source × spec.                                                                                                                                                                                                   |
| `volume_replicas` / `volume_shrink` / `privileged_port` / `cron_too_frequent`                 | render-time checks.                                                                                                                                                                                                  |
| `managed_root_forbidden` / `image_user_unverifiable` (managed only)                           | `AppImageConfigReader` in the worker (§4.4).                                                                                                                                                                         |
| `worker_not_isolated` / `env_source_unavailable` / `pull_credential_unavailable`              | platform configuration. `worker_not_isolated` is also returned when the dispatcher resolves `null`, `isEnabled()` is false, or the active runtime lacks `dispatchApp*` (§9.2).                                       |

### 5.2 License gate per target

The gate is **read, never stored** (Resolution R-3, CONTRACTS C3). At request time and again when work starts,
`AppLicenseService.getHostingEligibility(workId)` returns `{ none, yourCluster: 'allowed' | 'attestationRequired',
managed: 'allowed' | ManagedHostingReason, sourceOffer }`; this epic maps it:

| Eligibility field                     | Precondition                  | What APW-03 decides behind it                                                   |
| ------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| `yourCluster = 'attestationRequired'` | `license_attestation_missing` | amber, red, unknown until the owner attests (re-required on license change)     |
| `managed ≠ 'allowed'` (reason)        | `license_blocks_target`       | red never; amber only with a recorded upstream agreement; P2 verified Blueprint |
| `sourceOffer`                         | — (feeds §4.7 / T30)          | `network-source-offer` obligation **and** (relation `link` **or** ahead > 0)    |

The **Attest** action in `AppLicenseAttestationDialog` calls APW-03's `POST /api/works/:id/app-license/attest`
(owner only; any other member gets `403`, rendered as "Only the App Work's owner can attest.").
`work_app_runtime_states` has no attestation column.

### 5.3 Phases and numbers — `packages/contracts/src/apps/app-runtime.ts` _(new)_

```ts
export const APP_DEPLOY_REQUEST_BUDGET_MS = 2_000;
export const APP_PREPARE_TIMEOUT_S = 120;
export const APP_JOB_TIMEOUT_DEFAULT_S = 600; // spec default; spec range 10–3600
export const APP_ROLLOUT_EXTRA_S = 120;
export const APP_ROLLOUT_MIN_S = 300;
export const APP_ROLLOUT_MAX_S = 2_400;
export const APP_ROLLOUT_POLL_S = 5;
export const APP_ROLLOUT_RESTARTS_FAIL = 3;
export const APP_ROLLOUT_STUCK_POD_S = 180; // ImagePullBackOff / CreateContainerConfigError
export const APP_WORKER_STABLE_S = 30;
export const APP_SMOKE_IN_CLUSTER_WINDOW_S = 120;
export const APP_SMOKE_RETRY_S = 10;
export const APP_SMOKE_PUBLIC_FIRST_WINDOW_S = 600;
export const APP_SMOKE_PUBLIC_WINDOW_S = 180;
export const APP_SMOKE_BODY_BYTES = 1_048_576;
export const APP_SMOKE_FOUND_CHARS = 200;
export const APP_PUBLISH_TIMEOUT_S = 60;
export const APP_DEPLOY_MAX_DURATION_S = 7_200;
export const APP_ENV_SECRETS_KEPT = 3;
export const APP_ROLLBACK_CANDIDATES = 20;
export const APP_JOB_RUNS_KEPT = 3;
export const APP_JOB_TTL_S = 86_400;
export const APP_TMP_SIZE_MI = 256;
export const APP_PAUSE_TIMEOUT_S = 120;
export const APP_REMOVE_TIMEOUT_S = 300;
export const APP_HEALTH_POLL_S = 60;
export const APP_HEALTH_BATCH = 500;
export const APP_HEALTH_POLL_TIMEOUT_S = 20;
export const APP_HEALTH_CLUSTER_CONCURRENCY = 5;
export const APP_HEALTH_FAILS_TO_NOTIFY = 5;
export const APP_HEALTH_PASSES_TO_RECOVER = 3;
export const APP_HEALTH_UNREACHABLE_POLLS = 10;
export const APP_HEALTH_NOTIFY_DEDUPE_H = 6;
export const APP_STATUS_STALE_S = 180;
export const APP_STATUS_REFRESH_MIN_S = 15;
export const APP_CERT_NOTIFY_AFTER_MIN = 30;
export const APP_LOG_LINES_DEFAULT = 200;
export const APP_LOG_LINES_MAX = 500;
export const APP_LOG_BYTES_MAX = 262_144;
export const APP_LOG_CACHE_S = 300;
export const APP_LOG_REDACT_MIN_CHARS = 8;
export const APP_CLUSTER_CHECK_TIMEOUT_S = 30;
export const APP_CLUSTER_DIAL_TIMEOUT_S = 10;
export const APP_ISOLATION_PROBE_TIMEOUT_S = 3;
export const APP_DOMAIN_RECONCILE_S = 60;
export const APP_MANAGED_MAX_PER_USER_DEFAULT = 3;
export const APP_MANAGED_CRON_MIN_INTERVAL_MIN = 5;
export const APP_SUBDOMAIN_LABEL_MIN = 3;
export const APP_PREVIEWS_MAX = 3;
export const APP_PREVIEW_CLOSE_REMOVE_MIN = 10;
export const APP_PREVIEW_IDLE_H = 72;
```

Component deadline = `clamp(startup.period × startup.failureThreshold + readiness.period ×
readiness.failureThreshold + 120, 300, 2400)` seconds (web default with the renderer's startup default:
`10×60 + 10×3 + 120 = 750`).

### 5.4 Rollout predicate and failure classifier — `app-rollout.ts` _(new)_

Component rolled out ⇔ `metadata.generation ≤ status.observedGeneration` **and** `updatedReplicas = replicas`
**and** `availableReplicas = replicas` **and** `unavailableReplicas` absent/0 **and** no ReplicaSet other than
the newest has ready pods, and — for workers without probes — each new pod has `restartCount = 0` for 30 s.
Early failure from pod status: any container `restartCount ≥ 3` since the Deployment started
(`crash_loop`, with `lastState.terminated.exitCode` and `reason`), `waiting.reason ∈ {ImagePullBackOff,
ErrImagePull, CreateContainerConfigError, CreateContainerError, InvalidImageName}` for ≥ 180 s, `OOMKilled`
counted as a restart and reported (`oom_killed`), `ProgressDeadlineExceeded` condition (`rollout_timeout`).
**Added (APW06-G07):** a Deployment whose templates are unchanged is rolled out as soon as the predicate holds
(generation unchanged, no new ReplicaSet). The worker 30 s stability check and `crash_loop` apply only to pods
created after the Deployment started; restart counts are measured from that moment.

### 5.5 Phase machine and rollback — `app-deployer.ts` _(new)_

```
capture = read live Deployments/CronJobs/Ingress (templates, replicas, hosts)   // before any change
prepare → [pre-deploy jobs unless skip] → rollout(all components in parallel)
  → [first-deploy jobs if isFirstDeploymentOnCluster] → in-cluster smoke (runner, Host: primary)
  → isolation probe → publish(Ingress apply) → hooks.verifyPublic(public + hairpin via runner)
  → post-deploy jobs → CronJobs → GC env Secrets/old Jobs → done
any failure/cancel/deadline in rollout..publish with capture non-empty
  → rollback: re-apply captured templates (image, envFrom secret, replicas) and captured Ingress hosts,
    wait with the same deadlines → 'rolled-back' | 'rollback-failed'
capture empty (first Deployment) → 'failed'; if policy.scaleFailedFirstDeployToZero → scale to 0
```

`hooks.isCancelled()` is checked between phases and every rollout poll. Public smoke classification lives in the
platform (`AppPublicSmokeService`, redirects never followed): DNS lookup of the host ≠ ingress address → `dns_not_pointing`; TLS
handshake/name failure → `tls_not_ready`; connect timeout → `unreachable`; response mismatch while the same check
passed in-cluster → `check_failed` (health-relevant). Only in-cluster failures and publish failures roll back.

### 5.6 `app-deploy` job — `packages/agent/src/app-runtime/app-deploy.orchestrator.ts` _(new)_

1. Load Deployment + runtime state; re-run §5.1 (race); unmet → `ERROR` with `appRender.preconditions`.
2. Build `AppRenderInput` (`app-render-input.builder.ts`): spec at `build.commitSha` (for strategy `image`,
   at `specCommitSha` — §5.8), env + dependency egress
   (`AppRuntimeEnvSource`), pull credential (`AppImagePullCredentialSource`), hosts (§8), ingress/TLS/network
   from target settings, policy from `AppsTierPolicy` (`ever-works-apps`) or the your-cluster defaults.
   `AppRuntimeEnvSource.resolve` receives `target: AppDeployTarget` (added, APW06-G08) so APW-07 can decide
   `ew-dep://` placeholders from the target rather than from the stored row.
3. Resolve credential: `your-cluster` → Work-scoped `k8s` plugin settings through `DeployFacadeService.
getPluginAndTokenAndSettings`, `clusterSource` must be `custom-kubeconfig` (any other value →
   `target_not_checked`), `validateClusterSourceForOwner(dataRepoOwner, …)`, then the guard (§6.1), and the call goes
   to the `k8s` plugin; `ever-works-apps` → `AppsTierPolicy.resolveClusterCredential(workId)` (a control-namespace-only
   credential) and the call goes to the `apps-tier` deployment plugin, which writes desired state (R-5). **Never**
   `k8s-works` / `k8s-works-shared` env kubeconfigs, and never the tier credential to the `k8s` plugin (unit-tested).
   The credential itself comes from `AppRuntimeTargetResolver.resolve(workId)` (§9.9), which is the **only** place
   cluster access is assembled and which also calls `prepareAppNamespace` (§3) so the namespace and its baseline
   policies exist before any dependency is provisioned (GAP-06).
4. `state = 'DEPLOYING'`, `startedAt`; call `deployApp`. Hooks write `appRender.phase`, `state = 'VERIFYING'` from
   `in-cluster-smoke`, and emit `app.deploy.started`, `app.job.*`, `app.smoke.*` events.
5. Map outcome → `state` (`READY`, `READY` + `appRender.warnings`, `ERROR`, `ROLLED_BACK`, `CANCELED`) and write
   `componentStatuses`, `jobResults` (in `appRender`), `smokeResult`, `completedAt`, `lastError` (≤ 500 chars).
6. Runtime state: `currentDeploymentId` (on READY), `firstDeployJobsCompletedAt` + `clusterFingerprint`,
   `ingressAddress`, `isolationEnforced`, `namespace`, `statusSnapshot` from `getAppStatus`.
7. Events + notifications (§9.3); release `deployLockId` with `WHERE "deployLockId" = :id`; if `queuedBuildId` →
   request a new Deployment for it.
8. **Dependency hooks (added, APW06-G08).** The orchestrator calls APW-07 through typed fakes until it lands:
   `AppDependenciesService.onAppRemoved(workId, { deleteData: true })` **before**
   `destroyApp(…, { deleteVolumes: true })` on the Remove-with-data path (and it reports `remaining` ⇒ the op
   ends with `mayRemain[]` and skips the volume and namespace delete); `onAppRemoved(workId, { deleteData: false })`
   after `destroyApp(…, { deleteVolumes: false })` on the keep-data path (§9.2); `list(workId)` for the deletion
   preview (§9.7); and `reconcile(workId)` after a committed change of `target` or `clusterFingerprint`
   (§9.1, GAP-05). `provisionEphemeral` is called by the `verification-deploy` op (§4.12).
9. **Upstream-sync verdict (added, APW06-G10 — APW-04 FR-51).** Inject APW-04's
   `APP_PROVISION_EVENTS_PORT` `@Optional()`; a failure is logged, never fatal, and never delays lock release.
   Skip rollback Deployments. Read `WorkUpstreamStateRepository.findByWorkId(workId)`; absent, or `lastSyncToSha`
   null, means skip. The Deployment's Build commit counts as "from the sync" when it equals `lastSyncToSha`, or
   when `isAncestorCommit?(dataOwner, dataRepo, lastSyncToSha, build.commitSha)` returns true (`null` or
   unsupported means equality only). If it counts and `upstreamSyncJudgedToSha !== lastSyncToSha`:
   set `upstreamSyncJudgedToSha = lastSyncToSha` whether the Deployment passed or failed; and if this Deployment
   emitted `app.smoke.failed` (an in-cluster smoke failure ending `ROLLED_BACK` or `ERROR`, or a public
   `check_failed` — `dns_not_pointing`, `tls_not_ready` and `unreachable` are warnings and do not count; a
   rollout or probe failure with no smoke run does not count), call
   `smokeFailedAfterUpstreamSync(workId, lastSyncFromSha, lastSyncToSha)`. The two extra columns are APW-02's
   (its T12 and `CreateWorkUpstreamStates` migration add `lastSyncFromSha` / `lastSyncToSha`).
   `targetUpdated(workId, namespace)` is called after `PUT :id/app-target` commits a change to `target`,
   `targetSettings.namespaceOverride` or the cluster credential, and after an `app-cluster-op` `cluster-check`
   completes (§9.10) — `namespace` is `runtimeState.namespace`, else the name §4.1 derives (override first).
10. Trigger.dev `maxDuration: 7200`, `retry: { maxAttempts: 1 }` (a retried apply could double-run migrations);
    `onFailure` marks the row `ERROR` (`worker_failed`) and releases the lock.

### 5.7 `app-smoke` job **C**

Re-runs the App spec smoke checks against the current live Deployment on demand (Deploy tab **Run smoke
tests**, APW-04's verification loop) using `runAppJob` with the runner plus `AppPublicSmokeService`; writes
`smokeResult` on the current Deployment and emits `app.smoke.passed|failed`. Inside `app-deploy` the same
services are called in-process so a failure can roll back within one job. The job's body is
`packages/agent/src/app-runtime/app-smoke.service.ts` (§9.10): load the current Deployment, run in-cluster
smoke through `runAppJob` with `AppJobRunRequest { runner: 'smoke', checks }`, then public smoke through
`AppPublicSmokeService`, write `smokeResult` on that Deployment, emit the events — **never** roll back.

### 5.8 Deployments without a Build (`build.strategy: image`) — added 2026-09-17 (APW06-G04)

`image` and `none` produce no `WorkBuild` (APW-05 FR-3), yet the Umami golden path and ACC-E2E-05's PR-cluster
half both install an App Work whose spec uses `strategy: image`. This section is that path; nothing above is
weakened — every rule that names a Build applies to `dockerfile` and `auto`, which is what those rules were
written for.

- **Source.** The effective spec at the deploy-branch head (`getEffectiveSpec`), or the `specCommitSha` given in
  the request. `build.commitSha` is therefore the **spec commit**, and the env-source context carries
  `buildCommitSha: null` (APW-03 schema §21 guarantees no spec reaching this point references it).
- **Identity, resolved once, in the worker, before `prepare`.** An anonymous registry manifest `HEAD` with the
  OCI index and manifest `Accept` headers. The registry host passes the §6.1 public-address guard, with a 10 s
  timeout. A `@sha256:` reference is only checked for existence; **a tag is resolved to a digest** and the
  Deployment records the warning `image_not_pinned`. Record `appRender.image = { reference, digest, resolvedFromTag }`.
  404 → `image_not_found`; 401/403 → `image_private_unsupported`; timeout or network error → `image_unresolvable`.
  Each ends the Deployment `ERROR` with its code. (On `ever-works-apps` a tag-only reference is refused **on
  request** with the precondition `image_not_pinned`, before any work starts.)
- **Render.** `image.reference = <repository>@<digest>`, `image.pull` absent (public images only), and
  `AppImagePullCredentialSource` is **never called**. On the managed tier `AppImageConfigReader` reads the image
  config anonymously for the root-user pre-check of §4.4.
- **Triggers.** In addition to §5.6's, `app.spec.applied` on the deploy branch while the strategy is `image`,
  `autoDeploy` is on and the target is not `none`, when the changed blocks include any of
  `APP_IMAGE_REDEPLOY_BLOCKS` = `build`, `components`, `jobs`, `cron`, `smoke`, `env`, `dependencies`, `domains`.
  Trigger name `spec-applied`. Saving a target with **Deploy now** ticked deploys when the effective spec is valid.
- **Queue.** Latest-wins through `queuedDeploymentId`; the queued row carries the spec commit and
  `queuedBuildId` stays `null`. A queued request from the other strategy is marked `SUPERSEDED`.
- **Domain change (§8.2).** `restart` redeploys the current Deployment's spec commit and recorded digest.
  `rebuild` behaves as `restart` under this strategy, with the warning `rebuild_not_applicable` — there is no
  Build to rebuild.
- **Rollback (FR-34).** Candidates are the Live rows among the last 20 to the same target. A rollback redeploys
  the recorded `specCommitSha` and digest and **never** re-resolves the tag; image existence is checked in the
  worker, not by `WorkBuild` retention. The Deploy tab's history row shows the short digest instead of a Build link.
- **`strategy: none`.** `nothing_to_deploy`: Builds still run and the Deploy tab explains why there is nothing
  to run; nothing is queued.

### 5.9 Requests without a cluster call

`GET app-status` never dials: `POST app-status/refresh` records the fetched snapshot and `POST app-logs` caches
its tail (§9.10), so the API path stays free of App cluster I/O (FR-5).

---

## 6. Cluster access

### 6.1 Kubeconfig guard — `packages/plugins/k8s/src/app/app-kubeconfig.guard.ts` _(new)_

Runs in the worker, before `KubeConfig.loadFromString`:

1. Parse with `parseKubeconfig`; refuse (`K8sPluginError('KUBECONFIG_UNSUPPORTED', reason)`) when the selected
   user has `exec`, `auth-provider`, `tokenFile`, `client-certificate`, `client-key`; the cluster has
   `certificate-authority` (file), `insecure-skip-tls-verify: true`, `proxy-url`, or lacks
   `certificate-authority-data`.
2. `server` must be `https:`; host is an IP literal or resolved (`dns.lookup(all: true)`) with 10 s timeout.
3. Every address must pass `isPublicAddress(ip, allowlist)` — IPv4 denies `0/8, 10/8, 100.64/10, 127/8, 169.254/16,
172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4,
240/4, 255.255.255.255/32`; IPv6 denies `::/128, ::1/128, ::ffff:0:0/96` (mapped → re-check v4), `64:ff9b::/96`
   (re-check embedded v4), `100::/64, 2001:db8::/32, fc00::/7, fe80::/10, ff00::/8`. Allow-list CIDRs from
   `EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST` override the deny list. **Added (APW06-G20):** the classifier and the
   allow-list parser live in the plugin SDK as
   `packages/plugin/src/helpers/cluster-address-policy.ts` _(new)_ — `parsePrivateAllowlist(raw)` →
   `{ cidrs, invalid }`, `isPublicAddress(ip, allowlist)` and
   `resolvePublicAddresses(host, { allowlist, resolver?, timeoutMs = 10_000 })`, importing `node:dns` / `node:net` and
   therefore addressed by subpath (`@ever-works/plugin/helpers/cluster-address-policy`) like `ssrf-guard`, **not**
   re-exported from the helpers barrel. The `k8s` plugin reads its own process env through `parsePrivateAllowlist` and
   logs each invalid entry; it never imports agent config, and `AppTargetRef`, `AppRenderInput` and
   `AppClusterCheckRequest` keep their shapes so the R-5 contract is untouched. §8.3's
   `getClusterPrivateAllowlist()` returns `parsePrivateAllowlist(env).cidrs`, and `AppHostsService` uses
   `resolvePublicAddresses` before any DNS record write and on re-validation — the agent never imports
   `@ever-works/k8s-plugin`.
4. Rewrite the in-memory kubeconfig: `server: https://<validated ip>:<port>`, `tls-server-name: <original host>`
   — the client never re-resolves. Redirects are not followed (client-node does not follow them for API calls;
   asserted in a test with a mocked 307).
5. Same guard applies to the ingress address before it becomes a DNS record target (§8.3).

### 6.2 The isolated worker

- All App cluster I/O runs in Trigger.dev tasks on queue `app-cluster-io` (`concurrencyLimit: 20`). The API module
  imports no App cluster code path. **Added (APW06-G02):** `AppRuntimeFacadeService` is _constructed_ in every
  process that imports `FacadesModule`, so it cannot throw on construction — **every method call** throws
  `APP_CLUSTER_IO_IN_API` unless `isAppClusterWorkerContext()` is true. The flag lives in
  `packages/agent/src/app-runtime/worker-context.ts` _(new)_ (`markAppClusterWorkerContext()` /
  `isAppClusterWorkerContext()`) — a process-level flag, **not** an env var — and only the
  `TriggerAppRuntimeModule` bootstrap provider calls `markAppClusterWorkerContext()` in `onModuleInit` (§6.4).
  The API module graph never imports that provider, and a unit test asserts it.
- Production (`NODE_ENV=production`) refuses to dispatch any `app-*` cluster job unless
  `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true` (**C**) — an operator attestation that the worker for this queue has
  no route to internal networks; the network design itself lives in the private operations repository.
- **The generic Work plugin-settings route gains a kind-`app` branch (added, APW06-G01).**
  `PATCH /api/works/:workId/plugins/:pluginId/settings` calls
  `PluginValidationService.tryValidateConnection` today (`apps/api/src/plugins/plugins.controller.ts:566`), which
  reaches `KubernetesPlugin.validateConnection` (`packages/plugins/k8s/src/k8s.plugin.ts:595-616`) and **dials the
  pasted cluster from the API process** — before `assertSupportedKubeconfig`, before the public-address check and
  before any isolated worker, contradicting FR-3 ("refused before any connection attempt"), FR-4 and FR-5. When
  the Work's kind is `app` and the plugin has the `deployment` capability, that route now **skips**
  `tryValidateConnection` and returns `validation: null`; App Works save their kubeconfig only through
  `POST :id/app-target/check` (§9.1), which stores it and dispatches `cluster-check` to the worker. Non-app Works
  are byte-identical to today (ACC-06-43).
- The existing `validateConnection` / `listClusterNodes` behaviour for non-app Works is unchanged (additive rule);
  the App path never calls them.

### 6.4 Worker composition — added 2026-09-17 (APW06-G02)

`packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts` _(new)_ is booted with
`NestFactory.createApplicationContext` by `app-deploy`, `app-smoke`, `app-cluster-op`, `app-health-poll` and
`app-preview-gc`. It is **not** `TriggerInternalModule`: that module is built entirely from `createRemoteProxy`
entries (`packages/tasks/src/trigger/worker/modules/trigger-internal.module.ts:61`, served by
`apps/api/src/trigger/trigger-internal.controller.ts`), so a task that boots it makes **every** call inside the
API — which for App runtime work would move cluster I/O back into the API and break FR-5.

| Provider                                                                                                                                                                                                                                                                        | Local or proxied | Why                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `TriggerPluginsModule.forRoot()`                                                                                                                                                                                                                                                | Local            | Loads the `k8s` and `apps-tier` plugins, and needs the same plugin-secret encryption key as the API to decrypt the Work-scoped kubeconfig. |
| `TriggerRemoteCacheModule.forRoot()`                                                                                                                                                                                                                                            | Local            | The shared 300 s cache behind `app-op:` / `app-logs:` (it is a `CACHE_MANAGER` adapter).                                                   |
| `TriggerFacadesModule` → `GitFacadeService`, `DeployFacadeService`                                                                                                                                                                                                              | Local            | The spec at the Build commit; the plugin settings that hold the kubeconfig. Their repositories arrive through the proxied rows below.      |
| `AppRuntimeFacadeService`, `AppDeployOrchestrator`, `AppRenderInputBuilder`, `AppImageReferenceResolver` (§5.8), `AppPublicSmokeService`, `AppHostsService`, `AppHealthService`, `AppRuntimeDeletionService`, `AppClusterOpRouter`, `AppLifecycleOpsService`, `AppSmokeService` | Local            | The work itself.                                                                                                                           |
| A bootstrap provider calling `markAppClusterWorkerContext()`                                                                                                                                                                                                                    | Local            | The only thing that turns the §6.2 flag on.                                                                                                |
| `WorkRepository` (already in `remoteMap`), `WorkDeploymentRepository`, `WorkAppRuntimeStateRepository`, `WorkCustomDomainRepository`, `WorkPluginRepository`                                                                                                                    | Proxied          | The worker owns no `DataSource`.                                                                                                           |
| APW-05 `WorkBuild` reads and APW-03 `AppLicenseService`                                                                                                                                                                                                                         | Proxied          | Owned by other epics; typed fakes until they land.                                                                                         |
| The ports `APP_RUNTIME_ENV_SOURCE`, `APP_IMAGE_PULL_CREDENTIAL_SOURCE`, `APP_RUNTIME_TARGET`, `APPS_TIER_POLICY`                                                                                                                                                                | Proxied by name  | Their implementations live in the API's module graph (§9.8).                                                                               |
| `NotificationService` (already in `remoteMap`), `DistributedTaskLockService`, `AppRuntimeEventRelayService` (§9.4)                                                                                                                                                              | Proxied          | Activity and notifications are written in the API process; `EventEmitter2` inside the worker never reaches `activity-log.listener.ts`.     |

**Rule.** This module imports **no** `DatabaseModule`, **no** TypeORM `DataSource` and **no** Redis client. Its
only platform endpoint is the internal Trigger API over HTTPS, which is what keeps the §6.2 no-internal-route
attestation achievable. RPC arguments carrying env values are never logged. Each new name is added to
`TriggerInternalController.remoteMap` with its constructor dependency appended last as `@Optional()` (the
existing arity rule), and `apps/api/src/trigger/trigger-internal.module.ts` imports the owning modules.

### 6.3 Connection check — `checkAppCluster`

`/version` (10 s) → `SelfSubjectAccessReview` for each required verb in the target namespace (or, when it does not
exist, `create namespaces` cluster-wide) → `IngressClass` list → controller namespace detection (list pods labelled
`app.kubernetes.io/name ∈ {ingress-nginx, traefik}` across namespaces; skipped on 403) → `ClusterIssuer` list
(`cert-manager.io/v1`, skipped when absent/403) → `StorageClass` list. Required: `get,list,watch,create,patch,
update,delete` on `deployments, services, ingresses, secrets, configmaps, serviceaccounts, persistentvolumeclaims,
jobs, cronjobs, networkpolicies`; `get,list` on `pods, replicasets, events`; `get` on `pods/log`. Optional:
`create namespaces`, `create,patch limitranges`. It also reads the ingress controller Service (the one behind
`controllerNamespace`/`ingressClasses`) and records `ingressAddress = { ip?, hostname? }` on the runtime state
**during the check** — not only when a Deployment finishes — so a custom domain can be verified before the first
Deployment (added, GAP-09); the address still passes the §6.1 public-address guard before it becomes a DNS record
target, and `checkAppCluster` never dials anything else. Result stored as `clusterCheck` (secret-free) with
`fingerprint` **inside** it (the `clusterFingerprint` **column** stays the deployed cluster, written by §5.6, so a
check of a different cluster can never silently re-point a live app). `k8s-api.service.ts` gains `applyObject`,
`readObject`, `listObjects`, `deleteObject`, `readPodLog`, `createSelfSubjectAccessReview` on the existing factory
(plus `authorizationV1Api`).

---

## 7. Data model

**Workspace backup (Resolution R-25).** `WorkAppRuntimeState` exports as `data/works/app-runtime-states.jsonl` through the parent Work ids, and the new `WorkDeployment` columns ride the existing `deployments.jsonl`; nothing is redacted ([tasks](./tasks.md) T65).

**Portable columns (added 2026-09-17, APW06-G16).** Entities use only `TimestampColumn` (bigint epoch ms, as on
`WorkDeployment`), `simple-json`, `varchar`, `uuid`, `int` and `boolean`; `createdAt` / `updatedAt` use
`CreateDateColumn` / `UpdateDateColumn`. `packages/agent/src/entities/__tests__/portable-date-columns.spec.ts` bans
`timestamp` / `timestamptz` because better-sqlite3 cannot boot with them, so every column in §7.2 written as a date is a
nullable `TimestampColumn` and **every time comparison binds an epoch-ms parameter — never `now()`**. Nullability and
defaults are explicit: `target` varchar(24) NOT NULL default `'none'`; `targetSettings` simple-json NULL (the service
fills the defaults); `paused` and `deletionDeleteData` boolean NOT NULL default false; `deletionAttempts`,
`consecutiveFailures`, `consecutivePasses`, `unreachableStreak` int NOT NULL default 0; `health` varchar(16) NOT NULL
default `'unknown'`; the four uuid lock/queue/actor columns NULL; `clusterCheck`, `ingressAddress`, `statusSnapshot`
simple-json NULL; `isolationEnforced` boolean NULL.

### 7.1 `work_deployments` — additive columns (**C**: `buildId`, `componentStatuses`, `smokeResult`; added: `appTarget`, `appRender`)

| Column              | Type                | Meaning                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildId`           | uuid, null, indexed | `WorkBuild.id` deployed (no FK to keep APW-05 merge order free; validated in code). **Null for `build.strategy: image`** (§5.8).                                                                                                                                                                                                                                      |
| `componentStatuses` | `simple-json`, null | `[{ name, role, desired, ready, restarts, lastTerminationReason?, oomKilledAt? }]` at terminal state.                                                                                                                                                                                                                                                                 |
| `smokeResult`       | `simple-json`, null | `{ inCluster: CheckResult[], public: CheckResult[], hairpin?: CheckResult, classification?, observedAt }`.                                                                                                                                                                                                                                                            |
| `appTarget`         | varchar(24), null   | `your-cluster` · `ever-works-apps`.                                                                                                                                                                                                                                                                                                                                   |
| `appTrigger`        | varchar(24), null   | Added (APW06-G16): `manual` · `build` · `domain-change` · `rollback` · `target-saved`. The existing `triggerSource` column is `manual`/`scheduled` only, so the FR-23 sources had nowhere to live; `DeploymentTriggerSource` is widened with the four new values and `manual`/`scheduled` are unchanged. `triggeredByUserId` holds the actor and is null for `build`. |
| `appRender`         | `simple-json`, null | `{ phase, namespace, specCommitSha, envChecksum, image?: { reference, digest, resolvedFromTag }, jobResults[], warnings[], preconditions[], rollback?: { automatic, reason, restored, rolledBackToDeploymentId? }, cancelledBy?: 'user' \| 'quarantined' \| 'app_work_deleting', supersededBy? }`. Never values or log text.                                          |

New states: `DEPLOYING`, `VERIFYING`, `ROLLED_BACK`, `SUPERSEDED`. `isTerminal()` adds `ROLLED_BACK`,
`SUPERSEDED`. `providerProjectId` = namespace, `providerDeploymentId` = `<namespace>/<deploymentShort>`.

### 7.2 `work_app_runtime_states` _(new)_ — entity `WorkAppRuntimeState`

| Column                                                            | Type                        | Notes                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                                              | uuid PK                     |                                                                                                                                                                                                                                                                                                  |
| `workId`                                                          | uuid, unique, FK CASCADE    |                                                                                                                                                                                                                                                                                                  |
| `target`                                                          | varchar(24)                 | `none` (default; label "None — don't deploy yet", R-12) · `your-cluster` · `ever-works-apps`.                                                                                                                                                                                                    |
| `targetSettings`                                                  | `simple-json`               | `{ namespaceOverride?, ingressClass?, controllerNamespace?, tls, issuer?, storageClass?, networkIsolation: true, allowRoot: false, managedSubdomain: true, primaryDomain?, autoDeploy: true, previews: false }` — `managedSubdomain` is effective only when the apps domain is configured (R-16) |
| `namespace`                                                       | varchar(63), null           | **Frozen at the first `prepare-namespace` (dependency provisioning or first Deployment, whichever comes first) per `clusterFingerprint`** — added by GAP-06; `prepare-namespace` persists both.                                                                                                  |
| `clusterFingerprint`                                              | varchar(32), null           | From `parseKubeconfig`. Written by `prepare-namespace` and §5.6, never by a `cluster-check` (whose fingerprint lives inside `clusterCheck`).                                                                                                                                                     |
| `clusterCheck` / `clusterCheckedAt`                               | `simple-json` / timestamptz | Secret-free check result, incl. its own `fingerprint` and the `ingressAddress` the check observed.                                                                                                                                                                                               |
| `currentDeploymentId`                                             | uuid, null                  |                                                                                                                                                                                                                                                                                                  |
| `deployLockId` / `deployLockedAt`                                 | uuid / timestamptz          | Atomic claim; stale after 7 260 s (max duration + 60) → reclaimable. `claimDeployLock` also requires `paused = false` and `deletionRequestedAt IS NULL` (added by APW06-G03).                                                                                                                    |
| `cancelRequestedAt` / `cancelRequestedByUserId`                   | timestamptz / uuid, null    | The cancel flag `hooks.isCancelled()` reads, honoured only while `deployLockId` still holds the same Deployment id; `releaseDeployLock` clears both columns in the same UPDATE (added by APW06-G03).                                                                                             |
| `queuedBuildId` / `queuedDeploymentId`                            | uuid, null                  | Latest-wins queue of 1. For `build.strategy: image` `queuedBuildId` stays null and the row carries the spec commit (§5.8).                                                                                                                                                                       |
| `pendingDomainRebuildBuildId`                                     | uuid, null                  | The Build requested by a `rebuild` domain change (§8.2). Cleared when its Deployment is requested, or when that Build's `app.build.failed` / `app.build.cancelled` arrives (added by APW06-G11).                                                                                                 |
| `upstreamSyncJudgedToSha`                                         | varchar(40), null           | The upstream-sync `toSha` whose first Deployment has already been judged (APW-04 FR-51, added by APW06-G10).                                                                                                                                                                                     |
| `firstPublishedAt`                                                | timestamptz, null           |                                                                                                                                                                                                                                                                                                  |
| `firstDeployJobsCompletedAt`                                      | timestamptz, null           | Reset when `clusterFingerprint` changes.                                                                                                                                                                                                                                                         |
| `paused` / `pausedAt`                                             | boolean / timestamptz       |                                                                                                                                                                                                                                                                                                  |
| `removedAt`                                                       | timestamptz, null           |                                                                                                                                                                                                                                                                                                  |
| `deletionRequestedAt` / `deletionDeleteData` / `deletionAttempts` | timestamptz / boolean / int | App Work deletion in progress (§9.7); `deletionDeleteData` = the typed-confirmed "Also delete stored data".                                                                                                                                                                                      |
| `deletionRequestedByUserId`                                       | uuid                        | Who requested the deletion (Activity attribution). The fork/copy decision stays APW-01's and is carried out in its request.                                                                                                                                                                      |
| `ingressAddress`                                                  | `simple-json`, null         | `{ ip?, hostname? }`.                                                                                                                                                                                                                                                                            |
| `isolationEnforced`                                               | boolean, null               |                                                                                                                                                                                                                                                                                                  |
| `health`                                                          | varchar(16)                 | `unknown` · `healthy` · `degraded` · `down` · `unreachable`.                                                                                                                                                                                                                                     |
| `consecutiveFailures` / `consecutivePasses` / `unreachableStreak` | int                         |                                                                                                                                                                                                                                                                                                  |
| `lastHealthNotifiedAt` / `lastPolledAt` / `certInvalidSince`      | timestamptz                 |                                                                                                                                                                                                                                                                                                  |
| `statusSnapshot` / `statusObservedAt`                             | `simple-json` / timestamptz | `AppStatusSnapshot` (no log text).                                                                                                                                                                                                                                                               |
| `tenantId` / `organizationId`                                     | uuid, null                  | Scope columns, no relation decorators (entity-cycle precedent).                                                                                                                                                                                                                                  |
| `createdAt` / `updatedAt`                                         |                             |                                                                                                                                                                                                                                                                                                  |

Indexes: unique `workId`; `(target, paused, lastPolledAt)` for the poller; `(deployLockId)`; `(deletionRequestedAt)`.

`workId` keeps `ON DELETE CASCADE`: the row disappears only after §9.7 has removed the workloads and APW-01 deletes the
Work, so nothing needed for the teardown (target, namespace, fingerprint, Work-scoped kubeconfig) is gone before it runs.

### 7.3 Migrations (Constitution V; block `179206<slot>00000`)

- `apps/api/src/migrations/1792060000000-ExtendWorkDeploymentsForApps.ts` _(new)_ — five nullable columns + index on
  `buildId`. `down()` drops only them.
- `apps/api/src/migrations/1792060100000-CreateWorkAppRuntimeStates.ts` _(new)_ — table + indexes. `down()` drops the
  table.
- **Both are hand-written, idempotent `Table` / `TableColumn` / `TableIndex` DDL with `hasTable` / `hasColumn` /
  index-name guards, in the style of `apps/api/src/migrations/1791240000000-AddSafetyRailsCore.ts`** (added,
  APW06-G16). A `pnpm typeorm migration:generate` draft may be a starting point, but its dialect-specific SQL is never
  committed; time columns are `bigint` and `down()` drops only what `up()` created.

Newest migration on `develop` when written: `1791200100000-CreateOnboardingChecklists.ts`; on `ee45946e5`
(re-verified 2026-09-17): `1791240000000-AddSafetyRailsCore.ts`, still below this epic's block; re-stamp if moved.

---

## 8. Domains and DNS

### 8.1 Hosts — `app-hosts.service.ts` _(new)_

`primary` = the verified custom domain the owner marked primary (`targetSettings.primaryDomain`), else
`<managedSubdomain>.<EVER_WORKS_APPS_DOMAIN>` when `config.everWorks.apps.getDomain()` is non-null,
`targetSettings.managedSubdomain` is true and the label is allocated (Wave 1 on `your-cluster`, R-16), else `null`.
`extra` = verified `WorkCustomDomain` rows except primary, plus the managed subdomain when it is not primary. Unverified rows are never rendered. The App path does not
call `mergeCustomDomainHosts`, which stays untouched for other kinds. `previous` = hosts published by the current
Deployment that are no longer in `primary ∪ extra` while a `rebuild`-policy Deployment is pending.

### 8.2 Primary change → `domains.onChange`

`AppHostsService.onPrimaryChanged(workId)` (called by the subdomain PUT and the "make primary"/verify/remove
domain branches): `restart` → request a Deployment of `currentDeployment.buildId` with trigger `domain-change`;
`rebuild` → `AppBuildsService.requestRebuild(workId, { userId })` for the deploy-branch head, which records
trigger **`manual`** — the only requested trigger APW-05's deployable verdict accepts; `domain-change` is never a
Build trigger (added, APW06-G11). Store the returned `build.id` in
`work_app_runtime_states.pendingDomainRebuildBuildId`, also when `deduped: true`; a later primary change
overwrites it (latest wins). If the request is refused (`rebuildRateLimited`) or the Build is `blocked`, store no
marker, keep the saved primary, and write Activity plus an owner notice with the reason — the current Deployment,
and so the previous address, stays published. Under `build.strategy: image` (§5.8) `rebuild` behaves as
`restart` with warning `rebuild_not_applicable`. Non-primary add/remove →
`app-cluster-op { op: 'ingress-reconcile' }` which re-applies only the `Ingress` (≤ 60 s).

### 8.3 Managed subdomain on the apps domain (Your cluster from Wave 1 — Resolution R-16)

- **Phase.** Everything in this section except the `ever-works-apps` edge line ships in **P1**: an App Work on Your
  cluster gets `<slug>.<apps-domain>` with a DNS record to its public ingress address **and** any custom domains the
  tenant adds. `<apps-domain>` is `EVER_WORKS_APPS_DOMAIN`, which **defaults to `EVER_WORKS_DOMAIN`** — so the
  default managed address is `<slug>.ever.works` and a template install simply works (owner decision 2026-09-17,
  R-16). An operator may point `EVER_WORKS_APPS_DOMAIN` at a dedicated apex outside every platform domain; that
  configuration is kept in full, including its Public Suffix List checks (APW-10 LG-15) and the stricter validation
  below. The managed shape is disabled only when the configured apex fails that validation.
- Config `packages/agent/src/config/index.ts` gains `everWorks.apps`: `getDomain()` (`EVER_WORKS_APPS_DOMAIN` **C**,
  default `EVER_WORKS_DOMAIN`), `getMaxPerUser()` (`EVER_WORKS_APPS_MAX_PER_USER` **C**, default 3), `getDnsZoneId()`
  (`EVER_WORKS_APPS_DNS_ZONE_ID` **C**), `getDnsApiToken()` (`EVER_WORKS_APPS_DNS_API_TOKEN` **C**, secret),
  `isClusterWorkerIsolated()`, `getClusterPrivateAllowlist()`.
- Boot validation, in two branches. **Dedicated-apex branch** (operator set `EVER_WORKS_APPS_DOMAIN` explicitly): the
  apex must not equal, end with `.`+, or be a suffix of `EVER_WORKS_DOMAIN` or the host of the platform web/API URL —
  this is what keeps the cookie-isolating configuration honest. **Shared-default branch** (apex resolves to
  `EVER_WORKS_DOMAIN`): the equality check is satisfied by definition and recorded as such; the platform-domain
  safeguards of R-16 apply instead — host-only `__Host-` Secure cookies on platform routes, no platform session
  cookie on app hosts, app hosts never serving platform pages. In both branches a malformed or unusable apex makes
  the feature log an error and `getDomain()` return `null`, which disables the managed subdomain only — custom
  domains keep working.
- `AppsDomainDnsService` _(new, `packages/agent/src/ever-works-providers/apps-domain-dns.service.ts`)_ builds a
  `CloudflareDnsProvider({ apiToken, zoneId, rootDomain: appsDomain, targetHostname: '' })` — same precedent as
  `EverWorksDnsService` (a follow-up moves both behind the `dns` capability, EW-738).
- Allocation: `SubdomainAllocator.allocate(work, appsDnsOps)` at the first Deployment to `your-cluster` (the
  allocator's slug → `-<4 hex>` suffix rule gives `<slug>.<apps-domain>`); label length < 3 refused in the App branch of
  `ManagedSubdomainService`. Record: `ensureRecord({ host, type: ip ? 'A' : 'CNAME', target, proxied: false })` on
  `your-cluster` only after §6.1 validates the address; on `ever-works-apps` the tier edge owns wildcard DNS
  (`AppsTierPolicy.ingress().edgeTlsMode` — the value is a member of `ingress()`'s return, §5.1, not of the policy
  itself) and no per-app record is written. The health poll re-validates the address and
  updates or removes the record.

### 8.4 Existing routes, App branch

`DeployFacadeService.getDomains/addDomain/removeDomain/verifyDomain` and `ManagedSubdomainService` gain an early
`if (work.kind === 'app')` branch that delegates to `AppDomainsService` _(new)_: rows stored as today; verify uses
`verifyDomainResolution(domain, runtimeState.ingressAddress)`; success → `updateVerified` + reconcile/onChange;
remove → row delete + reconcile. DNS guidance uses `buildDnsGuidance(domain, ip ?? hostname)`.

---

## 9. API and background work

### 9.1 Routes — `apps/api/src/app-runtime/app-runtime.controller.ts` _(new)_, `@Controller('api/works')`

| Route                                               | Code      | Throttle       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | --------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST :id/deploy` **C**                             | 202       | 10/min member  | Kind `app` only (others: 400 pointing to `/api/deploy/works/:id`). Body `{ buildId?, confirmClusterChange? }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET :id/app-status` **C**                          | 200       | —              | Snapshot + `stale` flag + `sourceOffer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST :id/app-status/refresh`                       | 202       | 4/min per Work |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST :id/app-jobs/:name/run` **C**                 | 202       | 5/min member   | `{ confirmFirstDeploy? }`; 409 when a run of `:name` is active.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST :id/app-smoke`                                | 202       | 5/min member   | Dispatches `app-smoke`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST :id/app-rollback`                             | 202       | 10/min member  | `{ deploymentId, runPreDeployJobs?: false }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST :id/app-lifecycle`                            | 202       | 5/min member   | `{ action: 'pause'\|'resume'\|'remove'\|'cancel-deploy', deleteData?, confirmSlug? }`; `deleteData` requires `confirmSlug === work.slug`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST :id/app-logs` / `GET :id/app-logs/:requestId` | 202 / 200 | 10/min member  | `{ component? , job?, deploymentId?, previous?: boolean, lines ≤ 500 }`; result cached 300 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET :id/app-target` / `PUT :id/app-target`         | 200       | 10/min member  | Target + settings + APW-03 eligibility (read, never stored — R-3); PUT re-checks quota and eligibility.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST :id/app-target/check`                         | 202       | 6/min member   | Body `{ kubeconfig?: string (≤ 64 KiB), kubeContext?: string }`. When `kubeconfig` is present the API writes it as the Work-scoped `x-secret` of the your-cluster deployment plugin (resolved by capability — `supportsApps`, never `apps-tier`, never by id) with `clusterSource: 'custom-kubeconfig'`, through `PluginOperationsService.updateWorkPluginSettings`, which only checks the schema and connects to nothing. It then dispatches `app-cluster-op { op: 'cluster-check', workId }`; the payload never carries the kubeconfig, and the worker runs the §6.1 guard and then `checkAppCluster`, landing `KUBECONFIG_UNSUPPORTED` / `CLUSTER_ADDRESS_NOT_PUBLIC` in `clusterCheck`. |
| `GET :id/app-deletion-preview` (added, R-15)        | 200       | —              | `{ deferred, keeps: { volumes[], dependencies[] }, destroysWithData: [...] }` — names and sizes only; feeds APW-01's delete dialog.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**The App path never uses `PATCH /api/works/:workId/plugins/:pluginId/settings` and never calls any
`PluginValidationService` method for kind `app`** — that route calls `validateConnection` from the API process
and dials the pasted cluster before the §6.1 guard runs (§6.2, APW06-G01). The App Work kubeconfig is stored
only by `POST :id/app-target/check` above, and it is never parsed or loaded in the API.

`PUT :id/app-target` re-checks quota and eligibility, and after a **committed** change of `target`,
`targetSettings.namespaceOverride` or the cluster credential it (a) calls
`AppDependenciesService.reconcile(workId)` — APW-07's provisioning trigger (GAP-05), through a typed fake until
APW-07 lands — and (b) dispatches `app-cluster-op { op: 'prepare-namespace' }` so the namespace and its baseline
policies exist before the first dependency is provisioned (GAP-06). After a completed `cluster-check`, the
worker calls APW-04's `targetUpdated(workId, namespace)` `@Optional()` (APW06-G10).

**Access (added, APW06-G06).** Every route resolves access **first**, before the kind check, body validation,
throttle or dispatch, through `AppWorkAccessService.resolve(workId, userId, 'view' | 'edit')` (CONTRACTS §2A).
`GET` routes use `'view'`; all other routes use `'edit'`. Do **not** call `WorkOwnershipService.ensureCanView` or
`ensureCanEdit` directly: at HEAD they return 404 only when the Work row is missing, and for an existing Work
where the caller has no membership they return **403** `You do not have permission to access this work`
(`packages/agent/src/services/work-ownership.service.ts:74-81,107-113`), which existing non-App routes and e2e
specs depend on, so that 403 must not change. Mapping: (a) the Work is missing, or the caller is neither creator
nor member → **404** with the exact body of the missing-row branch (`{ status: 'error', message: "Work with id
'<id>' not found" }`), so it cannot be told apart from an unknown id (S25, ACC-06-40, ACC-NEG-13); (b) the caller
is a member below the required role → **403** (viewer on actions); (c) only after that, the kind check:
`POST :id/deploy` on kind ≠ `app` → 400 as in the table, and every other APW-06 route on kind ≠ `app` → 404
`notAppWork`, as in APW-05 §5 and APW-07. Leaving this to `ensureCanView`/`ensureCanEdit` produces a 403 where
the spec, T33 and ACC-NEG-13 require a 404, and lets a caller tell whether a Work id exists.

**Response shapes (added, APW06-G05).**

- `GET app-status` → `{ state: AppRuntimeState, target, stale: boolean, observedAt: string|null, url: string|null,
hosts: { primary: string|null, extra: string[] }, sourceOffer: { url }|null,
currentDeployment: { id, state, phase?, cancelReason? }|null, snapshot: AppStatusSnapshot|null, ops: AppOpEntry[] }`.
- `GET app-target` → `{ target, settings /* §7.2 targetSettings */, namespace: string|null,
clusterCheck: AppClusterCheck|null, clusterCheckedAt: string|null, eligibility: HostingEligibility }`.
  `PUT app-target` body `{ target, settings }` → 200 with the same shape; errors `422 { code:
'APP_TARGET_REFUSED', unmet: AppPrecondition[] }` (`managed_disabled`, `managed_ineligible`, `quota_exceeded`,
  `license_blocks_target`) and `409 APP_WORK_DELETING`.
- `GET app-logs/:requestId` → `{ status: 'pending'|'ready'|'failed', tail?: AppLogTail, code? }`; 404 after 300 s,
  and a `requestId` belonging to another Work misses for the same reason (`workId` is part of the cache key).
- Common errors: kind not `app` → 400 `APP_KIND_REQUIRED`; `deleteData` with `confirmSlug ≠ slug` → 422
  `CONFIRM_SLUG_MISMATCH`; another workspace → 404 (above).

Existing routes delegate for kind `app`: `DeployService.deploy()` (before the website work, next to the `repo`
refusal) → `AppDeployRequestService.request()`; `DeployController.rollback` → app rollback; `DeployController.deploy`
returns 202-shaped `{ status: 'pending', deploymentId }` and skips `deploymentVerifier.startVerification` for kind
`app`.

**The deploy-refusal token (added, APW06-G15).** APW-01 refuses kind `app` with `409 app_runtime_unavailable` until
APW-06's route exists, through a token **APW-01 declares** — `APP_DEPLOY_ROUTE_PORT` with
`requestDeploy({ workId, userId, buildId? })` → `{ status: 'pending'; deploymentId }`, in
`packages/agent/src/app-works/app-deploy-route.port.ts`, injected `@Optional() @Inject(...)` by `DeployService`. This
epic **binds** it (T34) from the global ports module (§9.8) with `useExisting: AppDeployRequestService`, visible to
`DeployModule` without a module cycle. While unbound the 409 stands; bound, the refusal disappears and no second
branch is added to `deploy.service.ts`. **The initial target (APW06-G15).** The value a person chose at creation is
derived once, at row creation, by `deriveInitialAppTarget(work.deployProvider)` in
`packages/agent/src/app-runtime/app-initial-target.ts` _(new)_ — via `PluginRegistryService`: a deployment plugin with
`isAppDeploymentPlugin` and **without** `apps-tier` ⇒ `your-cluster`; APW-01's persisted Ever Works Apps value or a
plugin declaring `apps-tier` **and** `AppsTierPolicy.isOpen()` ⇒ `ever-works-apps` (effective from T44, P2; closed or
unbound counts as closed); anything else (null, a website-only provider, an unresolved plugin) ⇒ `none`. It is never
re-derived afterwards, so a later `PUT app-target` wins, and a derived `ever-works-apps` stays subject to the
deploy-time quota and eligibility checks. `getOrCreate` becomes an insert-if-absent taking that value (T17), and FR-63
is the behaviour it implements.

### 9.2 Dispatchers and tasks

| Symbol / task id                               | File                                                                                                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_DEPLOY_DISPATCHER` / `app-deploy` **C**   | `packages/agent/src/tasks/app-deploy-dispatcher.ts`, `packages/tasks/src/tasks/trigger/app-deploy.task.ts` | Propagates dispatch errors (the row would strand).                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `APP_SMOKE_DISPATCHER` / `app-smoke` **C**     | `…/app-smoke-dispatcher.ts`, `…/app-smoke.task.ts`                                                         | `maxDuration: 900`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `APP_CLUSTER_OP_DISPATCHER` / `app-cluster-op` | `…/app-cluster-op-dispatcher.ts`, `…/app-cluster-op.task.ts`                                               | ops: `status-refresh`, `logs`, `pause`, `resume`, `remove`, `cancel-deploy`, `job-run`, `cluster-check`, `prepare-namespace` (added, GAP-06), `ingress-reconcile`, `dns-reconcile`, `delete-app-work` (R-15), `verification-deploy`, `verification-status`, `verification-destroy` (R-10); `maxDuration: 900`, overridden to 3 600 for `verification-deploy`. The task delegates to `app-cluster-op.router.ts` (§9.10), which routes by `op`; T48, T58 and T60 register their ops there. |
| `app-health-poll` (scheduled)                  | `…/app-health-poll.task.ts`                                                                                | `cron: '* * * * *'`; self-guarded by `DistributedTaskLockService`. The tick also calls the cache adapter's `cleanExpired()`, so a cached log tail never outlives 5 min + 60 s.                                                                                                                                                                                                                                                                                                           |
| `app-preview-gc` (scheduled, P3)               | `…/app-preview-gc.task.ts`                                                                                 | `cron: '*/5 * * * *'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

All run on queue `app-cluster-io`. Symbols added to `TASKS_BARREL_RUNTIME_SYMBOLS` alphabetically.

**The `dispatchers` view and the arity pin (added, APW06-G02).** `TriggerService` _is_ the `dispatchers` view, so
it gains `dispatchAppDeploy`, `dispatchAppSmoke` and `dispatchAppClusterOp`; they **propagate** errors and never
return `null` on a throw, and `dispatchersFromTenantClient` mirrors them with the propagate shape
`kb-reembed-work` uses, not `softDispatch`. Their ids join `TASK_IDS`, the three symbols join
`DISPATCHER_SYMBOLS`, and the arity pin in
`packages/agent/src/tasks/__tests__/job-runtime.providers.spec.ts:134-143` is updated — count it off the merged
list (14 at HEAD) rather than adding branch numbers.

**No in-process fallback for App runtime work (added, APW06-G02).** `buildJobRuntimeProviders` returns `null` when
no provider is registered, which preserves the in-process dev fallback for every existing dispatcher
(`packages/agent/src/tasks/job-runtime.providers.ts:158-200`); for App cluster work that fallback would run
cluster I/O in the API and break FR-5, so it does not apply: `AppDeployRequestService` and the op callers check
dispatcher availability **before** the lock claim. Unavailable means the dispatcher resolved `null`,
`isEnabled()` is false, or the active runtime lacks `dispatchApp*`; the request returns the precondition
`worker_not_isolated` (422) and creates no row. Outside production only, `EVER_WORKS_APPS_LOCAL_WORKER=true`
switches dispatch to a local worker process: `pnpm --filter @ever-works/trigger-tasks app-runtime:local-worker`
boots `TriggerAppRuntimeModule` and runs the same exported task run functions from a local queue. Production
refuses to boot with that flag set. The API process still never dials a cluster, so ACC-06-04 holds.

**Typed op payloads (added, APW06-G09)** live in `packages/agent/src/tasks/app-cluster-op.types.ts`, including the
three verification ops:

```ts
| { op: 'verification-deploy'; workId; provisioningId: string; attempt: number; buildId: string | null;
    imageDigest: string /* sha256 */; specCommitSha: string; ttlMinutes: number /* 1–240; APW-04 sends 90 */ }
| { op: 'verification-status'; workId; provisioningId: string; attempt: number; namespace: string }
| { op: 'verification-destroy'; workId; provisioningId: string | null; attempt: number | null;
    namespace: string; reason: 'attempt-ended' | 'cancelled' | 'expired' }
```

`verification-deploy` runs `checkAppCluster` first (10 s); a failure reports `state: 'unavailable'` through
`AppVerificationSink` and APW-04 falls back to its runner lane. `buildId` is `null` for `build.strategy: image`
(§5.8), in which case `imageDigest` and `specCommitSha` are the handles.

### 9.3 Health poll — `app-health.service.ts` _(new)_

Select `target ≠ 'none' AND paused = false AND removedAt IS NULL AND currentDeploymentId IS NOT NULL` ordered by
`lastPolledAt NULLS FIRST`, `LIMIT 500`; group by `clusterFingerprint`, 5 concurrent per cluster, 20 s per poll.
Each poll: `getAppStatus` + first `GET` smoke check over the public URL (runner not used; platform HTTP with the
public-smoke classifier). Verdict: `down` if primary web ready = 0; `degraded` if any web component ready <
desired or `check_failed`; `unreachable` on credential/connection errors; else `healthy`. Streak rules and
notifications per spec FR-47, dedupe key `app-health:<workId>`, ≤ 1 per 6 h. **The public ingress address is
re-validated on EVERY poll, not every tenth** — spec §4.6 requires it ("re-checked on every health poll (updated
if it changes, withdrawn if it stops being public)"), and it is the guarantee that stops a DNS record pointing at
an address that has since become private; an earlier draft deferred it to every 10th poll, which left up to ten
minutes of exposure. Every **10th** poll additionally re-resolves the **dependency egress hosts** (a larger, more
expensive list that carries no such public guarantee) — drift there dispatches `ingress-reconcile` /
`dns-reconcile`.

### 9.4 Events, Activity, notifications

`packages/agent/src/events/app-runtime.events.ts` _(new)_ — `AppDeployEvent` family with `EVENT_NAME`s equal to
the Activity actions (**C** §6): `app.deploy.started|succeeded|failed|rolled_back|paused|resumed|removed`,
`app.job.succeeded|failed`, `app.smoke.passed|failed`, `app.health.degraded|recovered|unreachable`. Payload:
`{ workId, userId, deploymentId?, buildId?, target, phase?, code?, names? }` — never values or log text.
**Emission order per Deployment** (asserted by ACCEPTANCE E2E-05): `app.deploy.started` → `app.job.*` in execution
order → the terminal `app.deploy.succeeded` \| `failed` \| `rolled_back` → `app.smoke.passed` \| `failed`
summarising the smoke results recorded on that Deployment (emitted after the terminal event even though smoke
ran before it, so one Deployment reads as one block).
**Emission crosses the process boundary through a port (added, APW06-G02).** The orchestrator and the App runtime
services never inject `EventEmitter2` — emitted inside the worker it would never reach
`apps/api/src/activity-log/activity-log.listener.ts` (`@OnEvent`). They call
`AppRuntimeEventSink.emit(event)` (§9.6). In the API the sink binds to `EventEmitter2`; in the worker it binds to
a proxy of the API-side `AppRuntimeEventRelayService.emit(name, payload)` (`apps/api/src/app-runtime/`), reached
through `TriggerInternalApiClient` like every other worker→API call. The relay accepts only names in the `app.*`
catalogue, runs the ACC-06-41 forbidden-key check, and re-emits through `EventEmitter2`, so the existing listener
writes Activity unchanged. Emission order is preserved because the calls are awaited in sequence. Notification
producers are called on the proxied `NotificationService`.
`activity-log.listener.ts` maps them (Resolution R-2) with `action` = the dotted event name and `actionType` = the
family: `app.deploy.*` → `ActivityActionType.APP_DEPLOY = 'app_deploy'`, `app.job.*` → `APP_JOB = 'app_job'`,
`app.smoke.*` → `APP_SMOKE = 'app_smoke'`, `app.health.*` → `APP_HEALTH = 'app_health'` (four additive enum values in
`packages/agent/src/entities/activity-log.types.ts`; the existing `DEPLOYMENT` value is not used for App Works).
Deleting an App Work records `app.deploy.removed` with `details.reason: 'app_work_deleted'`, `kept[]` and, when the
cluster was unreachable, `mayRemain[]` (object kinds and names only). Notification catalogue rows (added 2026-09-17,
APW06-G17 — every row of `core-event-catalogue.ts` requires `category`, `title`, `description` and `defaultChannels`,
and a Routine row also needs `alternativeSurface`; **all five are `category: 'system'`** (`NotificationCategory.SYSTEM`,
so no enum change and no mute alias), none is `persistent` and none is `emailGovernedByProfile`, urgent rows use
`IN_APP_AND_EMAIL` with `quietHoursBypassNeedsOptIn: true` and the rest `IN_APP`, and each producer passes its
`eventKey` as a string literal so the coverage scan can find it):

| Key                       | Urgent | Title                         | Description                                                                                                                                | Producer                      | Placement                                                                                                                        |
| ------------------------- | ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `app_deploy_failed`       | no     | App Deployment failed         | A Deployment of one of your App Works failed. Anything already live keeps running.                                                         | `notifyAppDeployFailed`       | signals                                                                                                                          |
| `app_rollback_failed`     | yes    | App rollback did not complete | A failed Deployment could not be rolled back to the previous version, so the app may not be serving.                                       | `notifyAppRollbackFailed`     | needsYou                                                                                                                         |
| `app_unhealthy`           | yes    | App is down                   | A live App Work failed its health check on 5 consecutive polls.                                                                            | `notifyAppUnhealthy`          | needsYou                                                                                                                         |
| `app_recovered`           | no     | App is back                   | An App Work that was reported down passed its health check on 3 consecutive polls.                                                         | `notifyAppRecovered`          | routine (`alternativeSurface: 'liveFeedWorkActivity'`, correct because `app.health.recovered` is written to the Work's Activity) |
| `app_cluster_unreachable` | yes    | Can't reach your cluster      | Ever Works could not reach the cluster of a live App Work on 10 consecutive polls. Deploying is refused until the connection check passes. | `notifyAppClusterUnreachable` | needsYou                                                                                                                         |

`event-registry-coverage.spec.ts` and `notification-matrix.service.spec.ts` pin catalogue counts, so T29 updates them
**as an intentional edit** (needsYou 11 → 14, routine gains `app_recovered`, signals 10 → 11, matrix length 24 → 29)
rather than leaving a failing spec. **Dedupe keys** — the unique index `(userId, deduplicationKey)` makes a reused key
block every later notification, dismissed or not — are `app-deploy-failed:<deploymentId>`,
`app-rollback-failed:<deploymentId>`, `app-unhealthy:<workId>:<failureStreakStartMs>`,
`app-recovered:<workId>:<same failureStreakStartMs>` (sent only when that streak's down notification was actually
created) and `app-cluster-unreachable:<workId>:<unreachableStreakStartMs>`; the at-most-one-per-6-hours limit is
enforced by §9.3 from runtime state, not by the key.

### 9.5 Quota — `ever-works-apps-quota.service.ts` _(new)_

Counter DI token `EVER_WORKS_APPS_QUOTA_COUNTER`; counts runtime states with `target = 'ever-works-apps' AND
removedAt IS NULL` for Works owned by the user. `assertWithinQuota` at `PUT app-target` and inside the
`deployLockId` claim transaction (`SELECT … FOR UPDATE` on the owner's runtime-state rows on Postgres; SQLite
tests use the serialized connection). Fails closed when `AppsTierPolicy.isOpen()` and the counter is
missing.

### 9.6 Ports — `packages/agent/src/app-runtime/ports.ts` _(new)_ **C**

```ts
export interface AppsTierPolicy {
	// semantics owned and implemented by APW-10; default: closed. The only way App Works code learns whether the tier
	// is open (R-5): nobody reads EVER_WORKS_APPS_MANAGED_ENABLED directly. The older name isManagedEnabled survives only
	// as an alias of isOpen on APW-10's implementation; no consumer calls it.
	isOpen(): boolean;
	managedScope(): 'verified-blueprints' | 'any';
	/** Control-namespace-only credential, handed only to the `apps-tier` deployment plugin — never to `k8s`. */
	resolveClusterCredential(workId: string): Promise<string>;
	/** runtimeClassName null ⇒ precondition `managed_sandbox_unavailable` from Wave 2 (R-24). */
	podPolicy(): { runtimeClassName: string | null; quota: AppQuotaInput; limitRange: AppLimitRangeInput };
	ingress(): { className: string; controllerNamespace: string; edgeTlsMode: 'edge' };
	/** Added (requested by APW-10 plan §5.5): owner eligibility for the tier; reasons are APW-10's codes. */
	eligibility(userId: string): Promise<{ eligible: boolean; reasons: string[] }>;
}
export interface AppImagePullCredentialSource {
	// implemented by APW-05
	resolve(workId: string, buildId: string): Promise<{ server: string; username: string; password: string } | null>;
}
export interface AppRuntimeEnvSource {
	// implemented by APW-07
	resolve(
		workId: string,
		specCommitSha: string,
		ctx: {
			/** Added (APW06-G08): APW-07 decides `ew-dep://` placeholders from the target, not the stored row. */
			target: AppDeployTarget;
			primaryUrl: string | null;
			primaryHost: string | null;
			/** Null under `build.strategy: image` (§5.8) — there is no Build commit. */
			buildCommitSha: string | null;
			internalUrls: Record<string, string>; // CONTRACTS §1 references
			preview?: { prNumber: number };
		}
	): Promise<{
		values: Record<string, string>;
		secretNames: string[];
		unsetRequired: string[];
		notReadyDependencies: string[];
		egress: Array<{ host: string; ports: number[] }>;
	}>;
	/** Ephemeral mode (R-10, CONTRACTS §3): nothing read from or written to stored generated values; prompted values
	 * only when already set. `target: 'cluster'` → in-memory `values` for a verification namespace (§4.12);
	 * `target: 'runner'` → a value-free `recipe` for APW-05's runner verification. */
	resolveEphemeral(
		workId: string,
		specCommitSha: string,
		ctx: {
			target: 'cluster' | 'runner';
			primaryUrl: string | null;
			primaryHost: string | null;
			buildCommitSha: string | null; // null under `build.strategy: image` (§5.8)
			internalUrls: Record<string, string>;
		}
	): Promise<{
		values?: Record<string, string>;
		recipe?: Array<{
			name: string;
			secret: boolean;
			source: 'generate' | 'literal' | 'template' | 'prompted';
			spec: unknown;
		}>;
		secretNames: string[];
		unsetRequired: string[];
	}>;
}
export const APPS_TIER_POLICY = Symbol('APPS_TIER_POLICY');
export const APP_IMAGE_PULL_CREDENTIAL_SOURCE = Symbol('APP_IMAGE_PULL_CREDENTIAL_SOURCE');
export const APP_RUNTIME_ENV_SOURCE = Symbol('APP_RUNTIME_ENV_SOURCE');

/**
 * Runtime target resolver (added, GAP-06 / APW06-G08). Worker-only, and the **only** place cluster access is
 * assembled. APW-07 consumes it; APW-06 implements it (§9.9).
 */
export interface AppRuntimeTargetPort {
	prepareDependencyTarget(
		workId: string
	): Promise<
		| { ref: AppTargetRef; podLabels: Record<string, string> }
		| { unavailable: 'target_none' | 'target_not_checked' | 'namespace_owned_elsewhere' | 'cluster_unreachable' }
	>;
}
/** Event sink (added, APW06-G02). Bound to EventEmitter2 in the API and to the relay proxy in the worker. */
export interface AppRuntimeEventSink {
	emit(event: { name: string; payload: Record<string, unknown> }): Promise<void>;
}
/** Verification result channel (added, APW06-G09). Implemented by APW-04; see §4.12. */
export interface AppVerificationUpdate {
	provisioningId: string;
	attempt: number;
	namespace: string;
	expiresAt: string;
	state: 'unavailable' | 'running' | 'green' | 'red' | 'infra' | 'blocked' | 'destroyed';
	phase: AppDeployPhase | 'cluster-check' | 'destroy';
	failure?: { phase: string; code: string; message: string };
	components: AppComponentStatus[];
	jobs: AppJobResult[];
	smoke: AppSmokeResult | null;
	pendingOnCapacitySince?: string;
}
export interface AppVerificationSink {
	report(update: AppVerificationUpdate): Promise<void>;
}
export const APP_RUNTIME_TARGET = Symbol('APP_RUNTIME_TARGET');
export const APP_RUNTIME_EVENT_SINK = Symbol('APP_RUNTIME_EVENT_SINK');
export const APP_VERIFICATION_SINK = Symbol('APP_VERIFICATION_SINK');
```

### 9.7 Deleting an App Work — `app-runtime-deletion.service.ts` _(new)_ (Resolution R-15)

The API never dials a cluster (§6.2) and the Work-scoped kubeconfig is deleted with the Work, so removal must run
**before** the Work row goes. `AppRuntimeDeletionService` (exported from `@ever-works/agent/app-runtime`) binds APW-01's
`APP_WORK_DELETION_PORT` (`packages/agent/src/app-works/app-work-deletion.port.ts`); APW-01's
`WorkLifecycleService.deleteWork` calls it for kind `app`, and this service calls back APW-01's
`WorkLifecycleService.completeAppWorkDeletion(workId)` when a pending removal ends. APW-07 and APW-10 are reached only
through this service.

**`preview(workId)`** returns `{ deferred, keeps, destroysWithData }`, where `keeps` lists volumes (`name`, `sizeGiB`)
and dependencies (`kind`, `label`) from the runtime state, the last `statusSnapshot` and APW-07's
`AppDependenciesService.list`. Names and sizes only. Served by `GET /api/works/:id/app-deletion-preview`.

**`requestDeletion({ workId, userId, deleteStoredData })`** → `{ status: 'pending' | 'done', target, reason? }` (the port
signature). The typed slug is confirmed in the delete dialog (`AppDeleteStoredDataSection`, T59) before APW-01 sends
`delete_stored_data: true`; the port carries only the boolean, and the fork or private copy decision never reaches this
epic.

| Case                                                                                | Result                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| target `none`, no runtime-state row, or no `currentDeploymentId` and no `namespace` | APW-07's `onAppWorkDeleting(workId, { deleteStoredData })` runs in-process (rows marked kept); `{ status: 'done', target }`; APW-01 deletes the Work now.                                                                                                                                                                                                  |
| `deletionRequestedAt` already set                                                   | `{ status: 'pending', target }`; nothing new is claimed or dispatched (idempotent).                                                                                                                                                                                                                                                                        |
| otherwise                                                                           | Atomic claim of `deletionRequestedAt`, `deletionDeleteData` and `deletionRequestedByUserId` (only when unset and no `deployLockId`; a running Deployment is cancelled first through `cancel-deploy`), one `app-cluster-op` dispatch with op `delete-app-work`, `{ status: 'pending', target }`; APW-01 answers `200 { deleting: true }` and keeps the row. |

**The `delete-app-work` op** on the isolated worker runs, in order:

1. APW-07 `AppDependenciesService.onAppWorkDeleting(workId, { deleteStoredData })` — kept rows and
   `app.dependency.released`, or deprovision and `app.dependency.data_deleted`; kept in-cluster dependency workloads
   are scaled to 0. On the Remove-with-data path this is APW-07's `onAppRemoved(workId, { deleteData: true })` and
   it is **awaited on the worker before** `destroyApp` (added, APW06-G08); when it reports `remaining`, the op ends
   with `mayRemain[]` and **skips** the volume and namespace delete. On the keep-data path
   `onAppRemoved(workId, { deleteData: false })` runs after `destroyApp`.
2. `destroyApp` with `deleteVolumes` equal to `deleteStoredData` (§3) — workloads, Jobs, CronJobs, Services, Ingress,
   env Secrets, platform ConfigMaps and the app's NetworkPolicies, keeping `ew-default-deny`, the `dep-<kind>`
   policies (labelled `ever-works.io/dependency`) while kept data remains. On
   `ever-works-apps` the `apps-tier` plugin's `destroyApp` calls APW-10's `removeWork(workId, { deleteData })` (R-5).
3. The managed DNS record is removed with `AppsDomainDnsService.removeRecord`.
4. Activity `app.deploy.removed` with `reason: 'app_work_deleted'` and `kept[]`; then APW-01's
   `WorkLifecycleService.completeAppWorkDeletion(workId)` deletes the Work (APW-01 already carried out the fork or
   private copy decision when the deletion was requested).

Transient failures (cluster unreachable) re-dispatch after 5 minutes, up to 3 attempts; after the third,
`app.deploy.removed` carries `mayRemain[]` and step 4 runs anyway.

While `deletionRequestedAt` is set, every action route answers `409 APP_WORK_DELETING`, preconditions report
`app_work_deleting`, and `GET app-status` returns `state: 'deleting'`.

### 9.8 Port publication and wiring — added 2026-09-17 (APW06-G12)

Placing the port bindings in `apps/api/src/app-runtime/app-runtime.module.ts` makes them invisible to
`packages/agent` consumers: `WorkLifecycleService` is provided by the non-global
`packages/agent/src/services/work.module.ts` and `AppRuntimeFacadeService` by the non-global
`packages/agent/src/facades/facades.module.ts`, and a non-exported provider in another module is not injectable
there. APW-01 injects `APP_WORK_DELETION_PORT` `@Optional()`, so an unbound token means deletion proceeds, the
Work row is deleted and the workloads keep running on the owner's cluster.

- All App runtime tokens are provided in exactly one place in the API:
  `apps/api/src/app-runtime/app-runtime-ports.module.ts` _(new)_, marked `@Global()`, providing and exporting
  `APPS_TIER_POLICY`, `APP_IMAGE_PULL_CREDENTIAL_SOURCE`, `APP_RUNTIME_ENV_SOURCE`, `APP_RUNTIME_TARGET`,
  `APP_RUNTIME_EVENT_SINK`, `APP_VERIFICATION_SINK` and `APP_WORK_DELETION_PORT`. It follows the precedent of
  `notifications/notification-email.module.ts` and `inbox/inbox.module.ts`.
- The disabled/unavailable implementations (§9.6) are the initial bindings. APW-05, APW-07 and APW-10 **replace the
  binding in this file** and never add a second provider for the same token.
- Consumers inside `packages/agent` (`WorkModule`, `FacadesModule`, `AppWorksModule`, the APW-03 catalog) never
  import it; it is global so they do not have to.
- `APP_WORK_DELETION_PORT` is bound with `useFactory` and `inject: [ModuleRef]`, resolving
  `AppRuntimeDeletionService` with `moduleRef.get(AppRuntimeDeletionService, { strict: false })` **when called**.
  It is never bound with `useExisting`, because the port and `WorkLifecycleService` form a cycle (same reasoning as
  `INBOX_PRODUCER`), and `AppRuntimeDeletionService` injects no `WorkModule` provider.
- Completion edge: the worker's `delete-app-work` handler, after steps 1–4 above, calls a remote proxy of
  `AppRuntimeDeletionService.finishDeletion(workId, { mayRemain })`. That method runs in the API, resolves
  `WorkLifecycleService` through `ModuleRef` and calls `completeAppWorkDeletion(workId)`. The relay entry goes into
  `apps/api/src/trigger/trigger-internal.controller.ts` and
  `packages/tasks/src/trigger/worker/modules/trigger-internal.module.ts` (`createRemoteProxy`).
- The worker context gets the tokens its code injects (`APPS_TIER_POLICY`, `APP_RUNTIME_TARGET`,
  `APP_RUNTIME_EVENT_SINK`) from `packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts` (§6.4).

### 9.9 Runtime target resolver — added 2026-09-17 (GAP-06 / APW06-G08)

`packages/agent/src/app-runtime/app-runtime-target.resolver.ts` _(new)_, exported from
`@ever-works/agent/app-runtime` as `AppRuntimeTargetResolver`, implementing `AppRuntimeTargetPort` (§9.6). APW-07
already cites "APW-06's runtime target resolver"; this is it, and it is the single place cluster access for an App
Work is assembled.

- `resolve(workId)` → `{ target: 'your-cluster', kubeconfig, context: string | null, namespace, appLabels,
clusterFingerprint }` or `{ target: 'ever-works-apps' | 'none', cluster: null }`.
- **Worker-only**: it throws `APP_CLUSTER_IO_IN_API` outside the worker context flag, exactly like T20.
- Kubeconfig: resolved as §5.6 step 3 (Work-scoped `custom-kubeconfig`, `validateClusterSourceForOwner`, the §6.1
  guard and pin). It never reads the `k8s-works` / `k8s-works-shared` env kubeconfigs and never uses the tier
  credential.
- `appLabels`: the §4.1 set (`managed-by`, `part-of`, `work-id`, `kind: app`).
- Namespace: the runtime-state `namespace` for the current `clusterFingerprint`; when unset, computed by §4.1 (or
  `targetSettings.namespaceOverride`) and persisted with a compare-and-set.
- **Before returning a `your-cluster` target it calls `prepareAppNamespace` (§4.2)** — namespace, ServiceAccount,
  LimitRange and (when isolation is on) the three baseline policies, idempotently — so
  `prepareDependencyTarget(workId)` is what breaks the namespace↔dependency cycle: APW-07's provider gets a
  namespace whose policies already exist, and no Deployment has to run first. `unavailable` mapping:
  `target_none` (no target chosen), `target_not_checked` (no passing cluster check),
  `namespace_owned_elsewhere` (the ownership check failed), `cluster_unreachable` (the credential or the API could
  not be used).
- `deployApp`'s `prepare` phase re-applies the same objects, so the two paths cannot drift.

### 9.10 `app-cluster-op` router, the op handlers and `app-smoke` — added 2026-09-17 (APW06-G03)

- `packages/agent/src/app-runtime/app-cluster-op.router.ts` _(new)_: `handle(payload)` routes by `op`. T48, T58 and
  T60 register their ops here; `app-cluster-op.task.ts` delegates to it, so no op lives in the task file.
- `packages/agent/src/app-runtime/app-lifecycle-ops.service.ts` _(new)_: the nine op handlers below.
- `packages/agent/src/app-runtime/app-smoke.service.ts` _(new)_: §5.7.
- `packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts` _(new)_: the Nest context of §6.4.

**Every handler** resolves the plugin and credential through `AppRuntimeFacadeService` (R-5); refuses
`op_unsupported_on_target` when the resolved plugin lacks the optional member it needs; refuses
`app_work_deleting` while `deletionRequestedAt` is set (R-15); and writes its outcome to `CACHE_MANAGER` under
`app-op:<workId>:<requestId>` = `{ op, state: 'queued'|'running'|'done'|'failed', code? }`, TTL 300 000 ms, which
`GET app-status` returns as `ops[]` (§2.3).

| Op                  | Body                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `status-refresh`    | `getAppStatus` → `saveSnapshot(statusSnapshot, statusObservedAt)`. On a connection or credential error, keep the previous snapshot and record the op `failed` with `cluster_unreachable`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `logs`              | `getAppLogs` (already redacted by T13) → `CACHE_MANAGER` key `app-logs:<workId>:<requestId>` = `{ state, tail?, code? }`, TTL 300 000 ms. `GET app-logs/:requestId` reads only that key; the `workId` prefix makes another Work's `requestId` answer 404. Nothing is written to `work_deployments`, runtime state or Activity; the `app-health-poll` tick sweeps expired entries.                                                                                                                                                                                                                                                                                                                              |
| `pause`             | Atomic `UPDATE … SET paused = true, pausedAt = now() WHERE workId = :w AND deployLockId IS NULL AND deletionRequestedAt IS NULL`; zero rows → `deploy_in_progress` (S27). Then `scaleApp('pause')`, emit `app.deploy.paused`, refresh the snapshot. The 120 s budget is FR-49's.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `resume`            | Claim `deployLockId = requestId` so a deploy or pause is refused meanwhile. `scaleApp('resume', <declared replicas from the spec at the current Deployment's `specCommitSha`>, { smoke, deadlines })` → `AppScaleResult` after a phase-3 rollout wait (`isComponentRolledOut`, `componentDeadlineSeconds`) and the phase-5 in-cluster smoke. Then `paused = false`, emit `app.deploy.resumed` (with `code` on failure; **no rollback** — the app stays resumed and health notifications follow FR-47), save the snapshot, release the lock. When the wait can exceed 840 s the handler saves a deadline and re-dispatches `resume` with `{ stage: 'wait' }` until the rollout finishes or the deadline passes. |
| `remove`            | Refuse while the deploy lock is held. `deleteData` → APW-07 `onAppRemoved(workId, { deleteData: true })` awaited first, then `destroyApp({ deleteVolumes: deleteData })`; `remaining` ⇒ end with `mayRemain[]` and delete no volume. Then remove the managed DNS record, set `removedAt`, clear `currentDeploymentId`, emit `app.deploy.removed` with `kept[]`. Steps are shared with T58's `delete-app-work`.                                                                                                                                                                                                                                                                                                 |
| `cancel-deploy`     | `UPDATE … SET cancelRequestedAt = now(), cancelRequestedByUserId = :u WHERE workId = :w AND deployLockId = :deploymentId`; zero rows → `no_deploy_in_progress`. `hooks.isCancelled()` reads that row with the same `deployLockId` (and is checked once before the `DEPLOYING` state); `releaseDeployLock` clears both columns in the same UPDATE, so a stale flag never cancels the next Deployment. The queued Build is left alone.                                                                                                                                                                                                                                                                           |
| `job-run`           | `runAppJob` (live image and `envFrom`; refuses while a Job of the same name is active), then write the result into `statusSnapshot.jobs` and emit `app.job.succeeded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | failed`. If the Job is still active near 840 s, re-dispatch `job-run { stage: 'wait', jobName }`. |
| `cluster-check`     | §6.1 guard → `checkAppCluster` → `clusterCheck = { ...result, fingerprint }` and `clusterCheckedAt`, plus the `ingressAddress` the check observed (GAP-09). It **never** writes the `clusterFingerprint` column. Then APW-04's `targetUpdated(workId, namespace)` `@Optional()` (APW06-G10).                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `prepare-namespace` | `prepareAppNamespace(ref, credential, { isolation, limitRange })` per §4.2; persists `namespace` and `clusterFingerprint`; idempotent; `your-cluster` and `ever-works-apps` both call it, while managed **dependencies** stay resolved in the zone under APW-10.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ingress-reconcile` | Hosts from `AppHostsService` → `publishAppHosts(ref, credential, { hosts, tls, ingress })`, which re-applies only the `Ingress` within 60 s and returns `ingressAddress`; then save it. Zero `deployApp` calls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**`app-smoke`** loads the current Deployment, runs in-cluster smoke through `runAppJob` with
`AppJobRunRequest { runner: 'smoke', checks }`, then public smoke through `AppPublicSmokeService`, writes
`smokeResult` on that Deployment and emits `app.smoke.passed|failed`. It never rolls back.

---

## 10. Web

### 10.1 Where it hangs

- `apps/web/src/app/[locale]/(dashboard)/works/[id]/deploy/page.tsx` — for `work.kind === 'app'`, return
  `<AppDeployPage>` **before** the website-repo redirect and before provider logic. Other kinds unchanged.
- `apps/web/src/app/[locale]/(dashboard)/works/[id]/page.tsx` — render `<AppHealthCard>` for kind `app` above
  `WorkStats`.
- APW-01's `apps/web/src/components/works/detail/settings/DeleteComponent.tsx` mounts this epic's
  `AppDeleteStoredDataSection` for kind `app` (R-15); APW-01 owns the dialog, this epic owns the section.

### 10.2 Components — `apps/web/src/components/works/detail/deploy/app/` _(new)_

`AppDeployPage` (server), `AppTargetCard` (target labels, **None — don't deploy yet** per R-12), `ConnectClusterDialog`,
`ClusterCheckResult`, `AppLiveCard` (state, URL, Source, pending-changes banner), `AppDeployButton` (Build picker: last
20 green Builds), `AppDeployProgress` (phases, polls `/api/works/[id]/app-status` BFF every 3 s while a Deployment runs,
else 30 s), `AppComponentsTable`, `AppSmokeResults` (in-cluster, public, hairpin rows), `AppJobsList` (Logs / Run now),
`AppCronList`, `AppHistoryTable` (existing deployments endpoint; Build link, Rollback, Logs), `AppLogsDrawer`,
`AppDangerZone` (pause, resume, remove with typed confirmation), `AppSourceOffer`, `AppLicenseAttestationDialog` (calls
APW-03's attest route; non-owner copy), `AppDeleteStoredDataSection` (kept list from `GET app-deletion-preview`, typed
slug). Existing `SubdomainManagement` and `DomainManagement` are reused; they call the same actions, and the API branch
does the rest (the managed subdomain on Your cluster shows the apps-domain suffix in P1).
`apps/web/src/components/works/detail/overview/AppHealthCard.tsx` _(new)_.

Server actions: `apps/web/src/app/actions/dashboard/app-runtime.ts` _(new)_. Client: `apps/web/src/lib/api/app-runtime.ts`
_(new, `server-only`)_. BFF: `apps/web/src/app/api/works/[id]/app-status/route.ts` _(new, cookie-authenticated like the
existing status route)_.

### 10.3 i18n

All keys in [`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json) under
`dashboard.workDetail.deploy.app` and `dashboard.workDetail.overview.appHealth`, mirrored in the 20 other locale
files. Leaf names camelCase, no `.`. Sub-trees: `targets` (`none` = "None — don't deploy yet", `yourCluster`,
`everWorksApps`, `unavailableReason`, `changeWarning`), `connect` (`title`, `kubeconfigHint`, `check`,
`refused.{command,file,proxy,insecure,noCa,notHttps,notPublic}`, `permissions.*`, `ingressClass`,
`tls.{issuer,external,none}`, `namespace`, `isolation.{on,off,offWarning}`, `save`), `states.*` (10 Deployment + 7 app
states incl. `deleting` and `cancelledQuarantined`), `phases.*` (11), `preconditions.*` (one per §5.1 code),
`ops.*` (one per §9.10 op), `failures.*` (`crashLoop`, `oomKilled`,
`imagePull`, `imageRunsAsRoot`, `imageUserUnverifiable`, `rolloutTimeout`, `jobFailed`, `smokeFailed`, `publishFailed`,
`rollbackFailed`, `imageNotPinned`, `imageNotFound`, `imagePrivateUnsupported`, `imageUnresolvable`),
`smoke.{inCluster,public,hairpin,hairpinWarning}`, `jobs.*`, `cron.*`, `history.*`,
`rollback.{confirm,disclaimer}`, `logs.*`, `lifecycle.{pause,resume,remove,deleteData,typeToConfirm,refusedDuringDeploy}`,
`deletion.{kept,alsoDeleteStoredData,typeToConfirm,generatedValuesWarning,deleting,mayRemain}`,
`source.{link,disclaimer,privateWarning}`, `license.{attest,attested,ownerOnly}`, `domains.{managedSubdomain,httpWarning}`,
`health.*`.

---

## 11. Failure modes

| Failure                                        | Chosen behaviour                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Worker dies mid-Deployment                     | `onFailure` → `ERROR (worker_failed)`, lock released; runtime-state lock stale after 7 260 s.         |
| Cluster API unreachable during rollout         | Retries polls for 60 s, then `failed` with `cluster_unreachable`; no rollback attempt (cannot reach). |
| Pre-deploy job hangs                           | `activeDeadlineSeconds` kills it → failed; running app untouched.                                     |
| SSA conflict with a hand-edited field          | `force: true` as today; the Activity entry notes fields overwritten are not tracked.                  |
| Namespace owned by another Work                | Precondition failure `namespace_foreign`; never adopted.                                              |
| Env source returns a value for an unknown name | Ignored with a warning; only spec-declared names are rendered.                                        |
| Build image deleted by retention               | `build_image_missing`; rollback button hidden for that row.                                           |
| DNS provider down                              | Deployment continues; `dns-reconcile` retried by the health poll; warning `dns_record_pending`.       |
| Tier reports isolation not enforced            | The tier refuses the desired state (APW-10); the Deployment ends `failed (isolation_not_enforced)`.   |
| Cluster unreachable while deleting an App Work | 3 attempts over 15 min, then the Work is deleted and `app.deploy.removed` lists `mayRemain[]`.        |
| Verification namespace outlives its attempt    | Expiry annotation; APW-04's sweep calls `verification-destroy`; destroy is idempotent.                |

---

## 12. Test plan

### 12.1 k8s plugin (Vitest)

- `src/app/__tests__/app-names.spec.ts` — namespace rule (slug truncation, 63 limit, preview and verification suffixes),
  labels exclude `ever-works.io/managed` / `app.kubernetes.io/name`.
- `app-manifest.renderer.spec.ts` — golden fixtures for the three sample App specs in APW-03 `schema.md` §24
  (web+worker+volume+jobs+cron; single web; two components); strategy by volume; envFrom not optional; digest image;
  TLS block only for `cert-manager`; verification variant (no Ingress, no CronJob, `emptyDir` volumes).
- `app-security.spec.ts` — the §4.4 table cell by cell; restricted namespace labels; port < 1024 rules.
- `app-network-policy.spec.ts` — every CIDR in §4.10; opt-out renders none; hairpin + deps egress.
- `app-jobs.renderer.spec.ts` — backoff/deadline/TTL; runner ConfigMap contains data not commands (fuzz paths with
  `$(`, backticks, quotes); cron auth via `secretKeyRef`; managed 5-minute rule; hairpin runner job targets the public URL.
- `app-rollout.spec.ts` — generation in metadata, updated/available replicas, old ReplicaSet with ready pods,
  crash loop at 3, stuck 180 s, OOM, worker stability 30 s.
- `app-deployer.spec.ts` — phase order; first-deploy jobs before publish; rollback restores captured templates;
  cancel before/after change; first Deployment failure keeps/scales; public failure no rollback; hairpin only when
  declared; verification purpose skips publish.
- `app-lifecycle.spec.ts` — `destroyApp` keeps PVCs, dependency objects and `ew-default-deny` without `deleteVolumes`;
  verification namespaces deleted whole.
- `app-kubeconfig.guard.spec.ts` — every refusal; every deny CIDR incl. mapped IPv6; allow-list; IP pinning with
  `tls-server-name`.
- `src/__tests__/e2e/app-runtime.e2e.spec.ts` _(new, kind)_ — non-root nginx image as web + busybox worker + migrate
  job + first-deploy http job + cron + PVC + smoke; rollback by deploying a crashing command; isolation reported
  **not enforced** on kindnet; delete-App-Work removal keeps the PVC; a verification namespace is created and destroyed;
  existing `cluster.e2e.spec.ts` unchanged.

### 12.2 Agent (Jest)

`app-deploy-preconditions.service.spec.ts` (every code), `app-license-gate.spec.ts` (eligibility mapping, no stored
attestation), `app-render-input.builder.spec.ts` (same-commit rule, never `GH_TOKEN`/platform tokens, pull credential only
from the port), `app-deploy.orchestrator.spec.ts` (state mapping, lock release, queue latest-wins, never `k8s-works*`
credentials, tier credential only to the `apps-tier` plugin), `app-health.service.spec.ts` (streaks, dedupe 6 h,
unreachable 10), `app-hosts.service.spec.ts` (verified-only, primary order, URL scheme per TLS mode, onChange),
`apps-domain-dns.service.spec.ts` (domain relation validation), `ever-works-apps-quota.service.spec.ts`,
`app-runtime-deletion.service.spec.ts` (immediate vs deferred, typed slug, retries, completion hand-back),
`app-runtime.facade.spec.ts` (plugin selection per target by capability), `app-runtime.events.spec.ts` (payload has no
value fields), notification `event-registry-coverage.spec.ts` stays green.

Added with the 2026-09-17 fix pass: `app-runtime-target.resolver.spec.ts` (worker-only; the guard runs on the
kubeconfig; the namespace is persisted once and reused; a foreign-owned namespace is refused
`namespace_foreign`; `ever-works-apps` returns `cluster: null`; no env kubeconfig is read),
`app-lifecycle-ops.service.spec.ts` and `app-smoke.service.spec.ts` (§9.10 — one case per op, tied to
ACC-06-05, -22, -25, -31, -34, -35, -36 and -37), `app-image-reference.resolver.spec.ts` (§5.8 — digest existence,
tag resolution, 404/401/timeout), `app-spec-applied.listener.spec.ts` (§5.8 triggers),
`app-cluster-op.router.spec.ts` (every op registered or explicitly unknown),
`app-runtime-ports.module.spec.ts` under `apps/api/src/app-runtime/__tests__/` (the module is global, exports every
token, the deletion-port provider has `useExisting`/`useClass` undefined and `inject: [ModuleRef]`, and a reduced
graph that does not import it still injects a working `APP_WORK_DELETION_PORT`), and
`packages/tasks/src/trigger/worker/modules/__tests__/trigger-app-runtime.module.spec.ts` (boots the application
context with a stubbed API client, resolves the orchestrator and the facade, asserts no `DataSource` in the
container).

### 12.3 API (Jest)

`app-runtime.controller.spec.ts` (every route: 202/409/422/404, throttles, typed slug, `app-deletion-preview`,
`409 APP_WORK_DELETING`), `deploy.service.spec.ts` + `deploy.controller.spec.ts` additions (kind app delegates; non-app
assertions untouched), migration specs under `apps/api/src/migrations/__tests__/`. No `apps/api/test/` suite (R-22).

### 12.4 Web

Vitest unit specs next to each new component; Playwright `apps/web/e2e/flow-app-deploy-target.spec.ts`,
`flow-app-deploy-lifecycle.spec.ts`, `flow-app-deploy-domains.spec.ts`, `flow-app-deploy-a11y.spec.ts` (axe on the Deploy
tab and its dialogs) (API mocked at the BFF boundary); locale parity via `apps/web/scripts/sync-locale-parity.mjs`
adding zero keys; existing `flow-work-deploy-*.spec.ts` pass unchanged.

### 12.5 Acceptance wiring

ACC-06-06, -10, -11, -12, -15, -18, -25, -35, -36, -45, -47, -48 are wired into [`../ACCEPTANCE.md`](../ACCEPTANCE.md) via
APW-13's fixture app on a kind cluster.

---

## 13. Phasing

### P1 — Wave 1: Your cluster (spec FR-1…FR-6, FR-9…FR-21, FR-23…FR-51 for Your cluster, FR-54…FR-62)

Contracts, renderer, guard, connection check, both migrations, preconditions with APW-03 eligibility, `app-deploy`,
`app-smoke`, `app-cluster-op` (incl. verification and delete ops), health poll, custom domains (verified-only), the
managed subdomain on Your cluster when the apps domain is configured (R-16), TLS modes, hairpin check, source offer,
pause/resume/remove, deleting an App Work (R-15), verification targets (R-10), web + i18n, kind e2e. **Ships value
alone:** the owner's example runs on their cluster, with a public URL when the operator configured the apps domain.

### P2 — Wave 2: Ever Works Apps for verified Blueprints (FR-7, FR-8, FR-22, FR-40 on the managed target)

`AppsTierPolicy` binding (APW-10 implementation) and selection of the `apps-tier` deployment plugin for target Ever
Works Apps (R-5), eligibility and sandboxed-runtime preconditions (R-24 — the tier must report a runtime class), quota,
managed-tier refusals (root image pre-check, cron frequency, privileged port) in the render input, edge-owned
managed hostnames. **Depends on** APW-10 P2 gate.

### P3 — Wave 3: any App Work on the managed tier + previews (FR-7 scope `any`, FR-52, FR-53)

`managedScope() === 'any'`, preview Deployments (`environment = preview`, `prNumber`, namespace
suffix, `app-preview-gc`), flag `works-app-previews` **C**.

---

## 14. Constitution compliance checklist

- [x] **I — Plugin-first.** All Kubernetes rendering and I/O for Your cluster is in `packages/plugins/k8s/src/app/`;
      Ever Works Apps is reached only through APW-10's `apps-tier` deployment plugin; DNS for the apps domain follows the
      existing concrete-provider precedent and is flagged for EW-738.
- [x] **II — No hard-coded plugin ids.** `AppRuntimeFacadeService` selects by `supportsApps` and the `apps-tier`
      capability; no `'k8s'` literal added outside the plugin (existing literals untouched).
- [x] **III — Source of truth.** The App spec and image both come from the Work Repository commit; the database holds
      runtime state and history only; the license attestation stays APW-03's single record.
- [x] **IV — Job runtime.** Every cluster action — including App Work deletion and verification targets — is a
      dispatched job; every action endpoint returns 202; overlap guarded by an atomic `UPDATE … WHERE "deployLockId" IS
NULL`, the deletion claim and `DistributedTaskLockService` for the poller.
- [x] **V — Forward-only migrations.** Two additive migrations in slots 00 and 01.
- [x] **VI — Tests.** §12; kind e2e for real-cluster behaviour.
- [x] **VII — Secrets.** Kubeconfig stays `x-secret`; env values only in cluster Secrets (verification values in memory
      only); logs redacted, cached 300 s, never persisted; Activity carries names only; the owner's Git token never
      reaches a cluster; the tier credential never reaches the `k8s` plugin.
- [x] **VIII — Plugin counts.** No plugin added.
- [x] **IX — Behaviour-first spec.** No file or class names in `spec.md`.
- [x] **X — Compatibility.** New `IDeploymentPlugin` members are optional; existing routes keep their contracts for
      every non-app kind; new `WorkDeployment` columns are nullable; new states only appear on app rows.
- [x] **Program rules** 1 (additive), 2 (one internal `*State` entity), 5 (202 + jobs), 8 (secrets), 9 (repository
      content is data: runner never interpolates), 10 (no infrastructure specifics; isolation design is private; existing
      deploy code is described generically — R-14), 11 (i18n), 12 (managed receipts linked from Activity).
- [x] **Program audit resolutions.** R-1, R-2, R-3, R-5, R-10, R-12, R-15, R-16, R-22, R-24 applied as listed at the top.

### Resolutions of the remaining 2026-09-17 audit findings

Each item below is additive; the section it belongs to is named so the resolution is not a second, competing statement.

- **Namespace permissions (APW06-G21).** §6.3's required list gains `create namespaces` **and**
  `delete namespaces`, both marked **required for verification targets and for a removal that deletes stored data**
  (not merely optional), with what is lost stated in the connection check. When a credential cannot create a namespace,
  a verification **refuses** with `verification_namespace_forbidden` so APW-04 falls back to its runner lane
  (`AppVerificationSink` reports `state: 'unavailable'`), and a removal that deletes stored data deletes the PVCs,
  **leaves the namespace**, and names it in Activity's `mayRemain[]`. T13 and T60 test both.
- **License and source-offer hand-offs (APW06-G22).** The Attest button in T37 reuses **APW-03's
  `AppLicenseAttestDialog`** rather than re-implementing it (falling back to APW-03's
  `attestation: { textId, commitSha, text }` returned by `GET app-target` when the component is not importable). §5.2's
  mapping narrows to APW-03's own reasons — `licenseNotGreen`, `upstreamAgreementMissing`, `entryDisallows` →
  `license_blocks_target` — while `managed_disabled` and `managed_scope_unverified_blueprint` come from
  `AppsTierPolicy`, so a single reason is never reported twice. APW-03's eligibility returns
  `sourceOffer: { required, repoWebUrl, sourceOfferUrl }` and **this epic appends the deployed commit** (§4.7), which
  removes the sha-parameter mismatch. The App Launcher's Source link (spec FR-44 / S12) is served by adding `sourceUrl`
  to APW-11's launcher item DTO — the launcher item is kept, never dropped from FR-44.
- **Playwright mechanism (APW06-G23).** T42's "BFF-mocked" specs get a named mechanism: **request-level Playwright
  against the real API with a non-production fake App deployment plugin** (`supportsApps: true`, deterministic
  results, enabled only when `EVER_WORKS_E2E_FAKES=1` and `NODE_ENV !== 'production'`) plus a seeding helper for
  runtime-state and Deployment rows (`apps/web/e2e/helpers/app-runtime-seed.ts` _(new)_). States that need a cluster are
  asserted in the kind lane through APW-13's `flow-app-works-kind-runtime.spec.ts`; flows reachable without a cluster
  stay in Playwright. The fake plugin is T-P1's, named here so the two lanes cannot both assume the other owns it.
- **Renderer fixtures (APW06-G24).** T6's golden fixtures cite the three APW-03 `schema.md` §24 examples **plus**
  APW-13's `app-fixture-hello`, and draft input App specs and their expected rendered manifests live under
  `APW-06-app-runtime/fixtures/` _(new)_ — one of them the `purpose: 'verification'` variant. APW-03 is asked for the
  missing `## 10. components[]` heading rather than this epic silently citing a section that does not exist.
- **i18n table (APW06-G25).** §10.3's key list gains a leaf-by-leaf table with final English copy for every §5.1
  precondition code, every §5.4 failure code, the 11 phases, the health states and the five notification titles and
  bodies; entries spec §6.7 already carries are marked as such. T41's parity command stays the gate.
- **A dropped Build-triggered Deployment (GAP-10).** A Build-triggered request whose preconditions are unmet persists
  `pendingAutoDeployBuildId` on the runtime state instead of being dropped, and re-evaluates it on `app.env.changed`,
  `app.dependency.provisioned`, `app.license.attested` and a target save, dispatching when every precondition passes
  (latest wins; cleared on dispatch, on a newer Build, and on `app.build.failed`/`cancelled` for that Build). T24 and
  T25 test the re-trigger for each of the four events, so a Build that succeeded while an env value was missing is not
  silently lost.
- **Upstream-sync provenance (GAP-18).** §5.6 step 9's verdict reads APW-02's `lastSyncFromSha` / `lastSyncToSha` and,
  when APW-02 records it, the sync PR's **merge commit** (`lastSyncMergeSha`), so "descends from the sync" is decided by
  the merge commit rather than by ancestry where the two disagree. `targetUpdated`'s emitter is this epic: the
  `cluster-check` and `PUT app-target` paths (T33, T70) — assigned, not left to a consumer that never called it.
- **Custom domains on the managed tier (GAP-27).** They ship in **Wave 2**, as APW-10 builds them (LG-17 is P2): T49's
  APW-10 service owns the edge hostname, and this epic's App-branch domain flow for `ever-works-apps` calls it through
  the `edge-hostnames` facade, publishes a host only when `status` and `certificateStatus` are both `active`, writes
  `hosts[].customHostnameRef`, shows the owner the TXT record and the CNAME target, and deletes the hostname on domain
  or App Work removal. The Wave-3 note in spec §9 is narrowed to _additional_ edge features, not to custom domains.

### Known gaps carried forward- The concrete apps-domain DNS provider mirrors `EverWorksDnsService` instead of resolving a `dns` capability.

- CONTRACTS §4 calls `POST /api/works/:id/deploy` "existing"; the existing route is `POST /api/deploy/works/:id`.
  This plan adds the contract route for kind `app` and makes the existing route delegate.
- Volume + replicas: resolved by CONTRACTS C2 (an APW-03 error and an APW-06 deploy-time refusal).
- Private-address clusters need the operator allow-list (spec §9).
- Kept data after an App Work is deleted has no card left to manage it (spec §9).
- **CONTRACTS changes requested by this fix pass**: §3 ports row gains `AppsTierPolicy.eligibility(userId)`,
  `AppRuntimeEnvSource.resolveEphemeral`, `AppRuntimeTargetPort` / `APP_RUNTIME_TARGET`,
  `AppRuntimeEventSink` / `APP_RUNTIME_EVENT_SINK` and `AppVerificationSink` / `APP_VERIFICATION_SINK`; §3's
  `IDeploymentPlugin` App additions row gains `publishAppHosts?` and `prepareAppNamespace?` and notes
  `scaleApp`'s `AppScaleResult` return; §3's `app-cluster-op` row gains `prepare-namespace` and "namespace
  preparation for dependencies"; §3's `AppRuntimeEnvSource.resolve` ctx carries `target`; §4 gains
  `GET /api/works/:id/app-deletion-preview` and the body of `POST /api/works/:id/app-target/check`; §2A gains
  `AppWorkAccessService.resolve(workId, userId, level)` (APW-01 owner, every App Works route a consumer) and the
  `AppBuildFinishedEvent` payload (APW-05 owner); §2's `WorkAppRuntimeState` row drops "license hosting
  attestation" and gains the deletion, cancel, `pendingDomainRebuildBuildId` and `upstreamSyncJudgedToSha`
  columns; the env table gains `EVER_WORKS_APPS_LOCAL_WORKER` (default `false`, refused in production); APW-01's
  `APP_WORK_DELETION_PORT.requestDeletion` is bound by `AppRuntimeDeletionService` **through the global
  `AppRuntimePortsModule`'s lazy `ModuleRef` factory** (never `useExisting`), and APW-01 exposes
  `completeAppWorkDeletion(workId)`, reached from the worker through
  `AppRuntimeDeletionService.finishDeletion` — applied in CONTRACTS §3.
- **Cross-epic text this fix pass corrects in other epics** (recorded here so it is not lost): APW-04 tasks.md T34
  drops `ewv-<work short id>-<attempt>` and cites §4.1, and its nightly check selects a verification namespace by
  the `ever-works.io/purpose: verification` label, not by name; APW-04 reaches the cluster only through
  `verification-*` ops and receives results through `AppVerificationSink`; APW-11 tasks.md line 401 moves the
  `MANAGED_HOST_ROOT_RESOLVER` binding from APW-06 P2 to APW-06 T48 (P1.8, R-16); APW-02's
  `work_upstream_states` gains `lastSyncFromSha` / `lastSyncToSha`; APW-13's kind lane sets
  `EVER_WORKS_APPS_LOCAL_WORKER=true` and starts the local worker process; APW-07 plan §4.8/§4.9 and T19 adopt
  `AppRuntimeTargetPort.prepareDependencyTarget` and the `dep-<kind>` policy in place of `namespacePoliciesMissing`;
  APW-10 moves the Quarantined→cancelled mapping from `getAppStatus` to the result of `deployApp`.
