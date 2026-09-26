import type { IPlugin } from '../plugin.interface.js';
import type {
	AppClusterCheck,
	AppClusterCheckRequest,
	AppDeployHooks,
	AppDeployResult,
	AppDestroyResult,
	AppJobResult,
	AppJobRunRequest,
	AppLimitRangeInput,
	AppLogRequest,
	AppLogTail,
	AppRenderInput,
	AppScaleResult,
	AppSmokeInput,
	AppStatusSnapshot,
	AppStatusSpec,
	AppTargetRef
} from './app-deployment.types.js';

/**
 * Deployment status
 */
export type DeploymentStatus = 'pending' | 'building' | 'deploying' | 'ready' | 'error' | 'cancelled';

/**
 * Deployment configuration
 */
export interface DeploymentConfig {
	/** Project/site name */
	readonly projectName: string;
	/** Source work to deploy */
	readonly sourceDir: string;
	/** Build command */
	readonly buildCommand?: string;
	/** Output work */
	readonly outputDir?: string;
	/** Environment variables */
	readonly env?: Record<string, string>;
	/** Custom domain */
	readonly domain?: string;
	/** Additional provider-specific options */
	readonly options?: Record<string, unknown>;
}

/**
 * Deployment result
 */
export interface DeploymentResult {
	/** Deployment ID */
	readonly id: string;
	/** Deployment status */
	readonly status: DeploymentStatus;
	/** Deployment URL */
	readonly url?: string;
	/** Preview URL (if different from main URL) */
	readonly previewUrl?: string;
	/** Error message if failed */
	readonly error?: string;
	/** Build logs URL */
	readonly logsUrl?: string;
	/** When deployment started */
	readonly createdAt: string;
	/** When deployment completed */
	readonly completedAt?: string;
}

/**
 * Deployment project/site information
 */
export interface DeploymentProject {
	/** Project ID */
	readonly id: string;
	/** Project name */
	readonly name: string;
	/** Production URL */
	readonly url?: string;
	/** Custom domains */
	readonly domains?: readonly string[];
	/** When project was created */
	readonly createdAt: string;
	/** Last deployment */
	readonly lastDeployment?: DeploymentResult;
}

/**
 * Domain information from deployment provider
 */
export interface DeploymentDomain {
	/** Domain name (e.g. 'example.com') */
	readonly name: string;
	/** Whether the domain is verified */
	readonly verified: boolean;
	/** Verification challenges if not verified */
	readonly verification?: readonly DeploymentDomainVerification[];
}

/**
 * DNS verification challenge for a domain
 */
export interface DeploymentDomainVerification {
	/** DNS record type (e.g. 'CNAME', 'TXT', 'A') */
	readonly type: string;
	/** DNS record name/host */
	readonly domain: string;
	/** DNS record value */
	readonly value: string;
	/** Human-readable reason for this record */
	readonly reason: string;
}

/**
 * Result of adding a domain
 */
export interface AddDomainResult {
	/** The domain that was added */
	readonly domain: DeploymentDomain;
	/** Whether the domain was verified immediately */
	readonly verified: boolean;
}

/**
 * Effective context for deployment operations that must use Work-scoped settings.
 *
 * Deployment plugins are singletons, so their PluginContext does not carry the
 * user/Work settings used by the deploy orchestrator. Facades may provide the
 * already-resolved Work settings and the namespace that deploy enforced.
 * Providers that do not need this context can ignore it.
 */
export interface DeploymentLookupContext {
	/** Work-scoped plugin settings, layered over singleton defaults. */
	readonly settingsOverride?: Record<string, unknown>;
	/** Namespace previously validated/enforced by the deploy orchestrator. */
	readonly namespaceOverride?: string;
	/** Current website repository/project name enforced by the orchestrator. */
	readonly projectNameOverride?: string;
	/**
	 * Context selected together with the effective kubeconfig. `null` means
	 * use that kubeconfig's operator-controlled current context.
	 */
	readonly kubeContextOverride?: string | null;
}

/**
 * Deployment plugin interface
 * Capability: 'deployment'
 */
export interface IDeploymentPlugin extends IPlugin {
	/** Provider name (e.g., 'vercel', 'netlify', 'cloudflare') */
	readonly providerName: string;

	/**
	 * Deploy a work
	 */
	deploy(config: DeploymentConfig, token: string): Promise<DeploymentResult>;

	/**
	 * Get deployment status
	 */
	getDeploymentStatus(
		deploymentId: string,
		token: string,
		context?: DeploymentLookupContext
	): Promise<DeploymentResult>;

	/**
	 * Validate API token
	 */
	validateToken?(token: string): Promise<boolean>;

	/**
	 * Get teams/organizations for the authenticated user
	 */
	getTeams?(token: string): Promise<Array<{ id: string; slug: string; name: string | null }>>;

	/**
	 * Lookup existing deployment for a project
	 */
	lookupExistingDeployment?(
		projectName: string,
		token: string,
		teamScope?: string,
		context?: DeploymentLookupContext
	): Promise<{
		found: boolean;
		website?: string;
		deploymentState?: string;
		projectId?: string;
	}>;

	/**
	 * Get authenticated user info
	 */
	getAuthenticatedUser?(token: string): Promise<{ username: string; email?: string } | null>;

	/**
	 * Get project information
	 */
	getProject?(projectId: string, token: string): Promise<DeploymentProject | null>;

	/**
	 * List all projects
	 */
	listProjects?(token: string): Promise<DeploymentProject[]>;

	/**
	 * Get domains for a project
	 */
	getDomains?(
		projectId: string,
		token: string,
		teamScope?: string,
		context?: DeploymentLookupContext
	): Promise<DeploymentDomain[]>;

	/**
	 * Add a domain to a project
	 */
	addDomain?(
		projectId: string,
		domain: string,
		token: string,
		teamScope?: string,
		context?: DeploymentLookupContext
	): Promise<AddDomainResult>;

	/**
	 * Remove a domain from a project
	 */
	removeDomain?(
		projectId: string,
		domain: string,
		token: string,
		teamScope?: string,
		context?: DeploymentLookupContext
	): Promise<boolean>;

	/**
	 * Verify a domain on a project
	 */
	verifyDomain?(
		projectId: string,
		domain: string,
		token: string,
		teamScope?: string,
		context?: DeploymentLookupContext
	): Promise<DeploymentDomain>;

	/**
	 * Workflow filenames to dispatch when deploying, in priority order.
	 *
	 * The deploy service tries these in order; the first one present in the
	 * website repo wins. If a plugin does not implement this, the deploy
	 * service falls back to its built-in default list.
	 */
	getWorkflowFilenames?(): string[];

	/**
	 * Extra GitHub Actions secrets/variables to push to the website repo
	 * before dispatching the deploy workflow.
	 *
	 * Keys are uppercase secret names; values are the secret values.
	 * Called server-side only — must never include the plugin's primary
	 * secret (e.g. kubeconfig, API token); the deploy service handles that
	 * via the existing `<PROVIDER>_TOKEN` push.
	 */
	getDeploymentSecrets?(settings: Record<string, unknown>): Promise<Record<string, string>>;

	/**
	 * Whether this plugin implements the App members below.
	 *
	 * Added by APW-06 (T2). **Optional** — a plugin that does not implement it
	 * is simply not an App deployment provider, and `isAppDeploymentPlugin`
	 * returns false for it. A plugin that does implement the App members
	 * declares `true` here.
	 */
	readonly supportsApps?: boolean;

	/**
	 * Deploy an App Work: render its objects, apply them, run the smoke checks,
	 * publish its hosts, and report each phase through `hooks`.
	 *
	 * Added by APW-06 (T2). **Optional.**
	 */
	deployApp?(input: AppRenderInput, credential: string, hooks: AppDeployHooks): Promise<AppDeployResult>;

	/**
	 * Observe the App Work's live state (components, jobs, cron, smoke,
	 * isolation, ingress address).
	 *
	 * Added by APW-06 (T2). **Optional.**
	 */
	getAppStatus?(ref: AppTargetRef, credential: string, spec: AppStatusSpec): Promise<AppStatusSnapshot>;

	/**
	 * Run one App spec job once. `runner: 'smoke'` runs the smoke checks
	 * instead of the named job's own command.
	 *
	 * Added by APW-06 (T2). **Optional.**
	 */
	runAppJob?(ref: AppTargetRef, credential: string, job: AppJobRunRequest): Promise<AppJobResult>;

	/**
	 * Remove the App Work's workloads, jobs, scheduled calls, services,
	 * published hosts and secrets.
	 *
	 * Never deletes a `PersistentVolumeClaim` or anything labelled
	 * `ever-works.io/dependency` unless `deleteVolumes` is true (R-15);
	 * dependency deprovisioning is APW-07's and runs before this call. With
	 * `deleteVolumes: false` it also keeps `ew-default-deny` while kept data
	 * remains (FR-50), and reports what it left behind in `kept`. For a
	 * verification namespace the whole namespace goes regardless of
	 * `deleteVolumes` (R-10).
	 *
	 * Added by APW-06 (T2). **Optional.**
	 */
	destroyApp?(ref: AppTargetRef, credential: string, opts: { deleteVolumes: boolean }): Promise<AppDestroyResult>;

	/**
	 * Pause or resume the App Work's components.
	 *
	 * `resumeChecks` is optional and only meaningful for `mode: 'resume'`: the
	 * plugin waits for the rollout and runs the in-cluster smoke checks before
	 * resolving with an `AppScaleResult`.
	 *
	 * Added by APW-06 (T2). **Optional.** Returns `AppScaleResult` (plan §3.1),
	 * not the App's status snapshot.
	 */
	scaleApp?(
		ref: AppTargetRef,
		credential: string,
		mode: 'pause' | 'resume',
		replicas: Record<string, number>,
		resumeChecks?: { smoke: AppSmokeInput[]; deadlines: Record<string, number> }
	): Promise<AppScaleResult>;

	/**
	 * Tail component or job logs (FR-48 limits), redacted by value.
	 *
	 * **Optional here.** APW-10's `IAppsTierProvider` declares its own
	 * `getAppLogs(workId, opts)` as a *required* member (tier log access —
	 * FR-7 / FR-48 route app logs through the tier); the two interfaces are
	 * different contracts and must not be conflated.
	 *
	 * Added by APW-06 (T2). **Optional.**
	 */
	getAppLogs?(ref: AppTargetRef, credential: string, req: AppLogRequest): Promise<AppLogTail>;

	/**
	 * Verify the credential can do everything a Deployment needs, and report
	 * what the cluster has (ingress classes, issuers, storage classes). The
	 * result is secret-free.
	 *
	 * Added by APW-06 (T2). **Optional.**
	 */
	checkAppCluster?(credential: string, req: AppClusterCheckRequest): Promise<AppClusterCheck>;

	/**
	 * Namespace preparation for dependency provisioning (GAP-06 / APW-07).
	 * Idempotent. Applies the namespace (ownership check and pod-security
	 * labels), the ServiceAccount, the LimitRange (403 → warning
	 * `limitrange_forbidden`) and — when `isolation` is true — the three
	 * baseline policies `ew-default-deny`, `ew-allow-same-namespace` and
	 * `ew-allow-egress`. It never draws `ew-allow-ingress` or `ew-allow-deps`,
	 * which only a Deployment draws, and never touches a `dep-*` policy.
	 *
	 * Added by APW-06 (T2). **Optional.**
	 */
	prepareAppNamespace?(
		ref: AppTargetRef,
		credential: string,
		opts: { isolation: boolean; limitRange: AppLimitRangeInput }
	): Promise<{ warnings: Array<{ code: string; message: string }> }>;

	/**
	 * Re-applies only the Ingress for the given hosts. Used by the
	 * `ingress-reconcile` op, which must never call `deployApp`. Returns the
	 * ingress address it observed.
	 *
	 * Added by APW-06 (T2). **Optional.**
	 */
	publishAppHosts?(
		ref: AppTargetRef,
		credential: string,
		hosts: {
			primary: string | null;
			extra: string[];
			previous: string[];
			tls: string;
			issuer: string | null;
		}
	): Promise<{ ingressAddress: { ip?: string; hostname?: string } | null }>;

	/**
	 * The expiry instant a **verification** namespace carries, as an ISO-8601
	 * string, or `null` when the namespace declares none.
	 *
	 * APW-06 §4.12:646-647 stamps a verification namespace with the purpose label
	 * and an expiry annotation (`now + ttlMinutes`), and §4.12:659-660 says that
	 * annotation is what lets APW-04's `app-provision-sweep` destroy leftovers a
	 * crashed run never cleaned up. Reading it back is therefore part of the
	 * verification contract, not a convenience — without it a `verification-status`
	 * answer cannot say when the namespace stops being valid.
	 *
	 * **Added by the coordinator (2026-09-18).** APW-06 T20's facade reported the
	 * gap: no member of this interface exposed the read, so the verification seam's
	 * optional `readNamespaceExpiry` could not be bound and a verification reported
	 * an EMPTY `expiresAt`. Additive and optional like every App member above, so no
	 * existing plugin changes. The `k8s` plugin implements it from the namespace's
	 * own annotations; a plugin that cannot answer omits it and the caller reports
	 * no expiry, which is the fail-open-for-reporting, never-fail-silently direction
	 * the seam already documents.
	 */
	readNamespaceExpiry?(ref: AppTargetRef, credential: string): Promise<string | null>;
}

/**
 * Type guard for deployment plugins
 */
export function isDeploymentPlugin(plugin: IPlugin): plugin is IDeploymentPlugin {
	return plugin.capabilities.includes('deployment');
}

/**
 * Type guard for App deployment plugins (APW-06 T2).
 *
 * A plugin is an App deployment provider when it declares `supportsApps: true`
 * **and** implements `deployApp`. Every other App member is optional, so this
 * guard is the supported way to narrow: after it, `deployApp` is callable and
 * the caller may assume the plugin serves an App target.
 *
 * Deliberately does **not** consult `capabilities` — a plugin may serve Apps
 * while also declaring other capabilities, and `ever-works-apps` declares both
 * `deployment` and `apps-tier`.
 */
export function isAppDeploymentPlugin(plugin: IDeploymentPlugin): plugin is IDeploymentPlugin & {
	readonly supportsApps: true;
	deployApp: NonNullable<IDeploymentPlugin['deployApp']>;
} {
	return plugin.supportsApps === true && typeof plugin.deployApp === 'function';
}
