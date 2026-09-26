/**
 * App Works — the App-deployment capability types (APW-06 T2).
 *
 * This module is the typed surface APW-04 (verification targets), APW-07
 * (namespace preparation and dependency egress), APW-10 (the Ever Works Apps
 * tier) and APW-13 (golden paths) compile against. `deployment.interface.ts`
 * merges the ten **optional** members that consume these types into
 * `IDeploymentPlugin`.
 *
 * **Additive-only (CONTRACTS R-26, top priority).** Every member this contract
 * adds to `IDeploymentPlugin` is optional, so a plugin that implements only the
 * pre-existing deployment members (the `k8s` plugin, the Vercel plugin, any
 * third party) still satisfies the interface and behaves exactly as it does
 * today. Nothing here removes, renames, reorders, weakens or narrows anything.
 *
 * Sources, in priority order:
 *
 * 1. `docs/specs/features/app-works/APW-06-app-runtime/plan.md` §3.1 — "Type
 *    reference (normative)": field-for-field, including optionality.
 * 2. `plan.md` §3 (the member block) and `tasks.md` T2 (the type list).
 * 3. `APW-03-app-spec-and-catalog/schema.md` §10 / §13 / §14 / §16 for the
 *    App-spec blocks the four `*Input` types are the *resolved* form of.
 *
 * Two divergences from a literal reading are called out inline rather than
 * silently resolved:
 *
 * - `AppDeployTarget` — `plan.md` §3 narrows it to the two deployable targets;
 *   R-12 / R-27 and `CONTRACTS.md` §2A make the chosen-target set the three
 *   values of `APP_DEPLOY_TARGETS`. The superset is implemented here.
 * - the App-spec `*Input` blocks — §3.1 aliases APW-03's `AppSpec*` types,
 *   which do not exist in `packages/contracts` yet, so the resolved fields are
 *   declared here from `schema.md` and stay structurally compatible when
 *   APW-03's module lands.
 */

/**
 * Where an App Work is deployed.
 *
 * `your-cluster` and `ever-works-apps` are the two targets a Deployment plugin
 * can be asked to act on; `none` is the third value of the App Work's chosen
 * deploy target (R-12 — "None — don't deploy yet", no separate deferred-deploy
 * state) and is what the runtime target resolver reports when no cluster is
 * chosen (`plan.md` §9.9: `{ target: 'ever-works-apps' | 'none', cluster: null }`),
 * so `AppRuntimeEnvSource` sees it too.
 *
 * Divergence: `plan.md` §3 declares this union as the two deployable values
 * only; R-12 / R-27 (`CONTRACTS.md` §0) and `APP_DEPLOY_TARGETS`
 * (`CONTRACTS.md` §2A — the single definition of `['none', 'your-cluster',
 * 'ever-works-apps']`) outrank that older text, so the superset is implemented.
 */
export type AppDeployTarget = 'none' | 'your-cluster' | 'ever-works-apps';

/**
 * The phase machine a Deployment reports through `AppDeployHooks.onPhase`
 * (`plan.md` §5.5).
 */
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

/**
 * One union collecting `plan.md` §5.4 (rollout classifier), §11 (failure modes)
 * and §10.3 (i18n keys). The constants module pins exactly this list.
 */
export type AppFailureCode =
	| 'crash_loop'
	| 'oom_killed'
	| 'image_pull'
	| 'create_container_config'
	| 'rollout_timeout'
	| 'job_failed'
	| 'smoke_failed'
	| 'publish_failed'
	| 'rollback_failed'
	| 'cluster_unreachable'
	| 'worker_failed'
	| 'isolation_not_enforced'
	| 'managed_root_forbidden'
	| 'image_user_unverifiable'
	| 'deadline_exceeded'
	| 'image_not_found'
	| 'image_private_unsupported'
	| 'image_unresolvable';

/**
 * The App state FR-46 reports, mapped from `health` + `paused` + `removedAt` +
 * `deletionRequestedAt`. `Deploying` and `Live with warnings` are the *current
 * Deployment's* states and are shown beside it, never instead of it.
 */
export type AppRuntimeState = 'not-deployed' | 'live' | 'degraded' | 'down' | 'unreachable' | 'paused' | 'deleting';

/**
 * The cluster an operation runs against. Deployment plugins are singletons with
 * no user context, so the ref — never plugin settings — carries the Work, the
 * namespace (frozen at the first namespace preparation) and the credential's
 * context.
 */
export interface AppTargetRef {
	/** App Work id. */
	readonly workId: string;
	/** The Work's app namespace (`ew-<slug ≤ 30>-<first 8 hex of workId>`, or a verification namespace). */
	readonly namespace: string;
	/** Chosen deploy target. A plugin only ever receives `your-cluster` or `ever-works-apps`. */
	readonly target: AppDeployTarget;
	/** Kube context selected together with the effective kubeconfig; `null` = current context. */
	readonly kubeContext?: string | null;
	/** Fingerprint of the cluster the Deployment was written against (`plan.md` §5.6). */
	readonly clusterFingerprint?: string;
}

/**
 * The 13 `ResourceQuota` keys of `plan.md` §4.2, as quantity strings / ints.
 * Property names are the literal Kubernetes quota keys so the renderer can
 * write them straight through.
 */
export interface AppQuotaInput {
	readonly 'requests.cpu': string;
	readonly 'limits.cpu': string;
	readonly 'requests.memory': string;
	readonly 'limits.memory': string;
	readonly pods: number;
	readonly persistentvolumeclaims: number;
	readonly 'requests.storage': string;
	readonly 'services.loadbalancers': number;
	readonly 'services.nodeports': number;
	readonly 'count/jobs.batch': number;
	readonly 'count/cronjobs.batch': number;
	readonly secrets: number;
	readonly configmaps: number;
}

/**
 * `LimitRange` defaults (`plan.md` §4.2). `max` per container is 8 CPU / 64Gi on
 * `your-cluster` and 2 CPU / 4Gi on `ever-works-apps`.
 */
export interface AppLimitRangeInput {
	readonly defaultRequest: { readonly cpu: string; readonly memory: string };
	readonly defaultLimit: {
		readonly cpu: string;
		readonly memory: string;
		readonly ephemeralStorage: string;
	};
	readonly max: { readonly cpu: string; readonly memory: string };
}

/**
 * Probe object (APW-03 `schema.md` §10), defaults resolved: exactly one of
 * `http` / `tcp` is set, and the renderer applies the declared periods.
 */
interface AppComponentProbeInput {
	/** `httpGet` path. */
	readonly http?: string;
	/** `tcpSocket` probe. */
	readonly tcp?: true;
	readonly periodSeconds: number;
	readonly timeoutSeconds: number;
	readonly initialDelaySeconds: number;
	readonly failureThreshold: number;
}

/** Component resources (APW-03 `schema.md` §10), defaults resolved. */
interface AppComponentResourcesInput {
	/** Request. */
	readonly cpu: string;
	/** Request. */
	readonly memory: string;
	/** Absent means no CPU limit (the renderer derives one on `ever-works-apps`). */
	readonly cpuLimit?: string;
	/** Limit. */
	readonly memoryLimit: string;
}

/** Persistent volume (APW-03 `schema.md` §10), default `backup: true` resolved. */
interface AppComponentVolumeInput {
	readonly name: string;
	readonly path: string;
	readonly size: string;
	readonly backup: boolean;
}

/**
 * An App component with its spec defaults resolved (`plan.md` §3.1), plus the
 * three values the renderer derives before rendering: `primary`,
 * `deadlineSeconds` and `internalUrl`.
 */
export interface AppComponentInput {
	readonly name: string;
	readonly role: 'web' | 'worker';
	/** Image entrypoint when absent. */
	readonly command?: readonly string[];
	/** Image cmd when absent. */
	readonly args?: readonly string[];
	/** Dockerfile stage override; `build.target` when absent. */
	readonly target?: string;
	/** Required for `web`, forbidden for `worker`. */
	readonly port?: number;
	readonly replicas: number;
	readonly writableRootFilesystem: boolean;
	/**
	 * The numeric uid the container must run as, when the App spec declares one
	 * (`schema.md` §10, added 2026-09-17 by APW06-G26).
	 *
	 * **Why this field exists.** An image whose `USER` is a **name** — Umami's is
	 * `nextjs` — cannot satisfy `runAsNonRoot`: the kubelet refuses it with
	 * "image has non-numeric user", which the rollout classifier maps to
	 * `image_user_unverifiable` (`plan.md` §4.4, §5.4). Before this field the App
	 * was undeployable on **both** targets with nothing the author could set, which
	 * is why the App spec gained `components[].runAsUser` and why the renderer
	 * needs to receive it.
	 *
	 * **Optional, and never derived.** Absent means the image's own user, exactly
	 * as before, so every existing App spec renders byte-identically. The renderer
	 * passes a supplied value through **verbatim** and must never invent one
	 * (`app-security.ts`'s `runAsUser` seam; validator rule R27 pins the range).
	 */
	readonly runAsUser?: number;
	readonly probes: {
		readonly startup?: AppComponentProbeInput;
		readonly readiness?: AppComponentProbeInput;
		readonly liveness?: AppComponentProbeInput;
	};
	readonly resources: AppComponentResourcesInput;
	readonly volumes: readonly AppComponentVolumeInput[];
	/** Whether this is the component `domains.primaryComponent` names — the only one with an `Ingress`. */
	readonly primary: boolean;
	/** Rollout deadline in seconds (`progressDeadlineSeconds`, `plan.md` §5.3). */
	readonly deadlineSeconds: number;
	/** `http://<name>.<namespace>.svc.cluster.local` (`plan.md` §4.3, CONTRACTS §1). */
	readonly internalUrl: string;
}

/**
 * An `http` job, cron or smoke request (APW-03 `schema.md` §13/§14). The runner
 * reads paths, bodies and expectations as data and never follows redirects, so
 * `expect.status` judges the first response. Any field left optional here keeps
 * the schema default and is resolved by the renderer.
 */
interface AppHttpRequestInput {
	/** `POST` when absent. */
	readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	readonly path: string;
	/** JSON body, `≤ 16 KiB` serialized; string leaves may hold `{{env.NAME}}` placeholders. */
	readonly body?: unknown;
	/** Names a `secret: true` env entry; sent as the `Authorization` header. */
	readonly authEnv?: string;
	/** `bearer` (default) sends `Authorization: Bearer <value>`; `raw` sends `Authorization: <value>`. */
	readonly authScheme?: 'bearer' | 'raw';
	/** `[200, 201, 204]` when absent. */
	readonly expect?: { readonly status?: readonly number[] };
}

/**
 * An App job with `component` resolved (`plan.md` §3.1). Exactly one of
 * `command` / `http` is set.
 */
export interface AppJobInput {
	readonly name: string;
	/** `first-deploy` jobs run before the app is exposed publicly. */
	readonly when: 'pre-deploy' | 'first-deploy' | 'post-deploy';
	/** Resolved from `domains.primaryComponent` when the spec is silent. */
	readonly component: string;
	readonly command?: readonly string[];
	readonly http?: AppHttpRequestInput;
	/** `600` when absent. */
	readonly timeoutSeconds?: number;
	/** `0` when absent. */
	readonly retries?: number;
}

/**
 * An App cron entry (APW-03 `schema.md` §14). §3.1 does **not** mark this block
 * as resolved, so `component`, `timeoutSeconds` and `concurrency` keep the
 * schema's optionality and the renderer applies the defaults (`plan.md` §4.9).
 */
export interface AppCronInput {
	readonly name: string;
	readonly schedule: string;
	/** `domains.primaryComponent` when absent. */
	readonly component?: string;
	readonly command?: readonly string[];
	readonly http?: AppHttpRequestInput;
	/** `300` when absent. */
	readonly timeoutSeconds?: number;
	/** `forbid` when absent. */
	readonly concurrency?: 'forbid' | 'allow';
}

/** A smoke request's `http` block (APW-03 `schema.md` §16). */
interface AppSmokeHttpInput {
	/** `GET` when absent. */
	readonly method?: 'GET' | 'HEAD' | 'POST';
	readonly path: string;
	/** JSON body, `≤ 16 KiB`, `POST` only. */
	readonly body?: unknown;
}

/**
 * An App smoke check with `name` and `component` resolved (`plan.md` §3.1). The
 * remaining `expect` / `when` defaults are resolved by the renderer.
 */
export interface AppSmokeInput {
	readonly name: string;
	/** Resolved; must name a `web` component. */
	readonly component: string;
	readonly http: AppSmokeHttpInput;
	readonly expect?: {
		/** `[200]` when absent. */
		readonly status?: readonly number[];
		readonly bodyContains?: readonly string[];
		readonly bodyNotContains?: readonly string[];
		/** `10000` when absent. */
		readonly maxLatencyMs?: number;
	};
	/** `always` when absent. */
	readonly when?: 'always' | 'first-deploy';
}

/** Pull credential for a private image registry. */
interface AppImagePullInput {
	readonly server: string;
	readonly username: string;
	readonly password: string;
}

/**
 * Everything a Deployment plugin needs to render an App Work's cluster objects.
 * Built by `app-render-input.builder.ts` (`plan.md` §5.6); pure input, no I/O.
 */
export interface AppRenderInput {
	readonly ref: AppTargetRef;
	/**
	 * R-10: `verification` renders a per-attempt namespace for APW-04 (`plan.md`
	 * §4.12); default `deploy`.
	 */
	readonly purpose?: 'deploy' | 'verification';
	/** Required when `purpose` is `verification`; written as the namespace's expiry annotation (1–240). */
	readonly ttlMinutes?: number;
	readonly workSlug: string;
	readonly deploymentId: string;
	/** 8 hex. */
	readonly deploymentShort: string;
	readonly specCommitSha: string;
	readonly isFirstDeploymentOnCluster: boolean;
	readonly skipPreDeployJobs: boolean;
	/** Digest-pinned reference (`…@sha256:<64 hex>`). */
	readonly image: {
		readonly reference: string;
		readonly pull?: AppImagePullInput;
	};
	readonly components: readonly AppComponentInput[];
	readonly jobs: readonly AppJobInput[];
	readonly cron: readonly AppCronInput[];
	readonly smoke: readonly AppSmokeInput[];
	/** Values come from `AppRuntimeEnvSource`; `secretNames` exist for redaction only. */
	readonly env: {
		readonly values: Record<string, string>;
		readonly checksum: string;
		readonly secretNames: readonly string[];
	};
	readonly hosts: {
		readonly primary: string | null;
		readonly extra: readonly string[];
		readonly previous: readonly string[];
	};
	readonly ingress: {
		readonly className: string | null;
		readonly controllerNamespace: string | null;
		readonly tls: 'cert-manager' | 'external' | 'none' | 'edge';
		readonly issuer: string | null;
	};
	readonly network: {
		readonly isolation: boolean;
		readonly extraEgress: readonly {
			readonly cidr: string;
			readonly ports: readonly number[];
		}[];
		readonly needsHairpin: boolean;
	};
	readonly policy: {
		readonly podSecurity: 'restricted' | 'baseline';
		readonly allowRoot: boolean;
		readonly runtimeClassName: string | null;
		readonly quota: AppQuotaInput | null;
		readonly limitRange: AppLimitRangeInput;
		readonly cronMinIntervalMinutes: number;
		readonly scaleFailedFirstDeployToZero: boolean;
		readonly requireIsolationEnforced: boolean;
	};
	readonly preview?: { readonly prNumber: number };
}

/**
 * The platform-side callbacks a Deployment plugin uses to report phases, ask
 * for the public smoke run and observe cancellation.
 */
export interface AppDeployHooks {
	/** Persist a phase (and optional detail) as the Deployment progresses. */
	onPhase(phase: AppDeployPhase, detail?: Record<string, unknown>): Promise<void>;
	/** Run the public half of the App spec smoke checks from the platform. */
	verifyPublic(req: {
		readonly urls: readonly string[];
		readonly checks: readonly AppSmokeInput[];
		readonly windowSeconds: number;
	}): Promise<AppSmokeRun>;
	/** Checked between phases and on every rollout poll. */
	isCancelled(): Promise<boolean>;
}

/**
 * The result of one check (smoke, job or cron request), `plan.md` §4.8 / §5.5.
 */
export interface CheckResult {
	readonly name: string;
	readonly status: 'passed' | 'failed' | 'skipped';
	readonly httpStatus?: number;
	readonly latencyMs?: number;
	readonly failedExpectation?: string;
	/** `≤ 200` chars, secret-scrubbed. */
	readonly found?: string;
	readonly classification?: 'dns_not_pointing' | 'tls_not_ready' | 'unreachable' | 'check_failed';
}

/** What `hooks.verifyPublic` resolves to. */
export interface AppSmokeRun {
	readonly checks: readonly CheckResult[];
	readonly passed: boolean;
}

/** The two halves of a Deployment's smoke run, plus the optional hairpin check. */
export interface AppSmokeResult {
	readonly inCluster: readonly CheckResult[];
	readonly public: readonly CheckResult[];
	readonly hairpin?: CheckResult;
	readonly observedAt: string;
}

/** Observed state of one component. */
export interface AppComponentStatus {
	readonly name: string;
	readonly role: 'web' | 'worker';
	readonly desired: number;
	readonly ready: number;
	readonly restarts: number;
	readonly lastTerminationReason?: string;
	readonly oomKilledAt?: string | null;
}

/** Where a container's logs can be fetched from. */
export interface AppLogRef {
	readonly component?: string;
	readonly job?: string;
	readonly pod: string;
	readonly container: string;
	readonly previous: boolean;
}

/** Observed state of one job run. */
export interface AppJobResult {
	readonly name: string;
	readonly when: 'pre-deploy' | 'first-deploy' | 'post-deploy';
	readonly runName: string;
	readonly status: 'succeeded' | 'failed' | 'timeout' | 'running';
	readonly startedAt: string;
	readonly completedAt?: string;
	readonly exitCode?: number;
	readonly http?: CheckResult;
	readonly logRef?: AppLogRef;
}

/**
 * What `deployApp` resolves to. `outcome` is deliberately not the Deployment
 * row's status: a rolled-back Deployment succeeded at rolling back.
 */
export interface AppDeployResult {
	readonly outcome:
		| 'succeeded'
		| 'succeeded-with-warnings'
		| 'failed'
		| 'rolled-back'
		| 'cancelled'
		| 'rollback-failed';
	/** Required when the outcome is `cancelled`, or `rolled-back` because of a cancel. */
	readonly cancelReason?: 'user' | 'quarantined' | 'app_work_deleting';
	/** `plan.md` §5.8 — present for build strategy `image` only. */
	readonly image?: {
		readonly reference: string;
		readonly digest: string;
		readonly resolvedFromTag: boolean;
	};
	readonly failure?: {
		readonly phase: AppDeployPhase;
		readonly code: AppFailureCode;
		readonly message: string;
		readonly logRef?: AppLogRef;
	};
	readonly warnings: readonly { readonly code: string; readonly message: string }[];
	readonly components: readonly AppComponentStatus[];
	readonly jobs: readonly AppJobResult[];
	readonly smoke: AppSmokeResult;
	readonly ingressAddress: { readonly ip?: string; readonly hostname?: string } | null;
	/** `null` when no probe ran (isolation off) or the probe was inconclusive. */
	readonly isolationEnforced: boolean | null;
	readonly firstDeployJobsCompleted: boolean;
}

/** What `getAppStatus` is asked to observe. */
export interface AppStatusSpec {
	readonly components: readonly {
		readonly name: string;
		readonly role: 'web' | 'worker';
		readonly replicas: number;
		readonly primary: boolean;
	}[];
	readonly jobs: readonly string[];
	readonly cron: readonly string[];
}

/**
 * A persisted status observation (FR-46). For a verification ref only
 * `components`, `jobs` and `smoke` are set (`plan.md` §4.12).
 */
export interface AppStatusSnapshot {
	readonly observedAt: string;
	readonly components: readonly AppComponentStatus[];
	readonly jobs: readonly { readonly name: string; readonly last?: AppJobResult }[];
	readonly cron: readonly {
		readonly name: string;
		readonly lastScheduleAt?: string;
		readonly lastSuccessAt?: string;
		/**
		 * `plan.md` §3.1 names this field without giving it a type; it carries a
		 * short outcome label for the last scheduled run, not an `AppJobResult`
		 * (the `jobs[]` entries use `last` for that).
		 */
		readonly lastResult?: string;
	}[];
	readonly smoke?: AppSmokeResult;
	readonly isolationEnforced: boolean | null;
	readonly ingressAddress?: { readonly ip?: string; readonly hostname?: string } | null;
}

/**
 * What `scaleApp` resolves to after the resume path's rollout wait and
 * in-cluster smoke (`plan.md` §9.10).
 */
export interface AppScaleResult {
	readonly components: readonly AppComponentStatus[];
	readonly smoke: AppSmokeRun | null;
	readonly failure?: { readonly code: AppFailureCode; readonly message: string };
}

/**
 * A manual job run. `runner: 'smoke'` runs the App spec smoke checks instead of
 * the named job's own command, and then `checks` carries them.
 */
export interface AppJobRunRequest {
	readonly name: string;
	readonly image: string;
	readonly confirmFirstDeploy?: boolean;
	readonly runner?: 'smoke';
	readonly checks?: readonly AppSmokeInput[];
}

/**
 * A log request (FR-48). `secretValues` exists for in-memory redaction only —
 * it is never logged and never stored.
 */
export interface AppLogRequest {
	readonly component?: string;
	readonly job?: string;
	readonly deploymentId?: string;
	readonly previous?: boolean;
	/** 1–500, default 200. */
	readonly lines: number;
	readonly secretValues: Record<string, string>;
}

/** A redacted log tail (FR-48 limits). */
export interface AppLogTail {
	readonly containers: readonly {
		readonly pod: string;
		readonly container: string;
		readonly lines: readonly string[];
		readonly truncated: boolean;
	}[];
	readonly redactedNames: readonly string[];
	readonly fetchedAt: string;
}

/** What `checkAppCluster` is asked to verify (`plan.md` §6.3). */
export interface AppClusterCheckRequest {
	readonly namespace: string | null;
	readonly needsCreateNamespace: boolean;
}

/**
 * The result of a cluster connection check. Secret-free by construction: it
 * carries capability names and object names only.
 */
export interface AppClusterCheck {
	readonly ok: boolean;
	readonly serverVersion?: string;
	readonly fingerprint: string;
	readonly missingPermissions: readonly {
		readonly verb: string;
		readonly resource: string;
	}[];
	readonly optionalMissing: readonly { readonly verb: string; readonly resource: string }[];
	readonly ingressClasses: readonly { readonly name: string; readonly isDefault: boolean }[];
	readonly controllerNamespace: string | null;
	readonly clusterIssuers: readonly string[];
	readonly storageClasses: readonly { readonly name: string; readonly isDefault: boolean }[];
	readonly error?: { readonly code: string; readonly message: string };
}

/**
 * What `destroyApp` resolves to. `kept` names every object deliberately left
 * behind (FR-50) — with `deleteVolumes: false` a retained PVC or anything
 * labelled `ever-works.io/dependency` keeps `ew-default-deny` in place.
 */
export interface AppDestroyResult {
	readonly deleted: readonly { readonly kind: string; readonly name: string }[];
	readonly kept: readonly { readonly kind: string; readonly name: string }[];
	readonly namespaceDeleted: boolean;
}
