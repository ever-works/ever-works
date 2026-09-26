/**
 * App dependencies — the provider contract (APW-07 plan §4.7, tasks T3).
 *
 * Owning epic: **APW-07 (App env & dependencies)**. Spec:
 * `docs/specs/features/app-works/APW-07-app-env-and-dependencies/spec.md`
 * FR-35…FR-50, FR-56…FR-63. Plan: §2.3 (provisioning), §4.7 (this contract),
 * §4.8 (the facade that selects one), §4.9 (the in-cluster providers),
 * §4.9a (`awaitingConfig`) and §4.10 (the external providers).
 *
 * ## Every closed set is imported, never restated (R-1)
 *
 * `AppDependencyKind`, `AppDependencyTarget`, `AppDependencySupport`,
 * `AppDependencyProvisionOutcome`, `AppDependencyDeprovisionOptions`,
 * `AppDependencyDeprovisionOutcome`, `AppDependencyResourceRefs`,
 * `AppDependencyBackupStatus` and `AppDependencyBackupPolicy` are declared in
 * `@ever-works/contracts` (`packages/contracts/src/apps/app-dependencies.ts`,
 * APW-07 T2 — landed) because the API, the agent and the web all read them. A
 * second declaration here would be exactly the drift R-1 exists to prevent, so
 * this file imports and re-exports them and adds only the shapes that are
 * genuinely plugin-facing: the descriptor, the context and the five methods.
 *
 * ## One plugin, several providers
 *
 * A plugin that declares the `app-dependency` capability answers for one or
 * more **provider ids** (`dependencyProviders`): the `k8s` plugin serves
 * `k8s-inline-postgres`, `k8s-inline-redis` and `k8s-inline-minio`, and
 * `app-dependencies-external` serves `smtp-external`, `s3-external` and
 * `platform-smtp-relay`. That is why every method takes the `providerId` its
 * caller selected from the descriptor list, and why
 * `WorkAppDependency` stores the pair `(providerPluginId, providerId)`.
 *
 * `supports` is given the context as well as the (kind, target) pair: a
 * provider may be unable to serve a target for a reason only the context can
 * answer — the `platform-smtp-relay` provider is offered only while its admin
 * settings are complete, and only to a verified account (FR-39, FR-61).
 */

import type {
	AppDependencyBackupPolicy,
	AppDependencyBackupStatus,
	AppDependencyDeprovisionOptions,
	AppDependencyDeprovisionOutcome,
	AppDependencyKind,
	AppDependencyProvisionOutcome,
	AppDependencyResourceRefs,
	AppDependencySupport,
	AppDependencyTarget
} from '@ever-works/contracts';
import type { IPlugin } from '../plugin.interface.js';
import type { JsonSchema } from '../../settings/json-schema.types.js';

export type {
	AppDependencyBackupPolicy,
	AppDependencyBackupStatus,
	AppDependencyDeprovisionOptions,
	AppDependencyDeprovisionOutcome,
	AppDependencyKind,
	AppDependencyProvisionOutcome,
	AppDependencyResourceRefs,
	AppDependencySupport,
	AppDependencyTarget
};

/**
 * What one provider declares about itself (plan §4.7:471-479, §4.9a:641).
 *
 * `preference` is the ONLY ordering input: lower wins, and the facade asks `supports` in ascending
 * order (plan §4.8:543-546). The numbers the plan fixes are `k8s-inline-*` 10, `smtp-external` 10,
 * `managed-*` 10, `s3-external` 20 and `platform-smtp-relay` 20 — so "your own SMTP server" is
 * offered before the platform relay, and an in-cluster S3-compatible server before an external one.
 */
export interface AppDependencyProviderDescriptor {
	/** `k8s-inline-postgres`, `smtp-external`, … — unique across every installed plugin. */
	readonly id: string;
	readonly kind: AppDependencyKind;
	/** Every target this provider can serve; `your-cluster` and/or `ever-works-apps`. */
	readonly targets: readonly AppDependencyTarget[];
	/** The card's provider line ("Your own SMTP server", "In your cluster · single instance"). */
	readonly label: string;
	/** Lower wins among the providers that support a (kind, target). */
	readonly preference: number;
	/** The owner-supplied configuration, `x-secret` marking a credential (FR-5: never echoed back). */
	readonly promptSchema?: JsonSchema;
	readonly backupPolicy: AppDependencyBackupPolicy;
	/**
	 * Added with plan §4.9a (`:641-644`): the provider needs something only the owner can supply,
	 * so `reconcile` inserts the row in `awaiting_config`, dispatches **nothing** and starts **no**
	 * deadline. `PUT …/:kind` with valid `config` moves it to `pending`.
	 *
	 * Absent means `false` — a provider whose prompt schema is satisfied by admin settings (the
	 * relay) skips the state entirely, which is why this is a descriptor flag and not an inference
	 * from `promptSchema`.
	 */
	readonly awaitingConfig?: boolean;
}

/**
 * Everything a provider is handed for one call (plan §4.7:480-498).
 *
 * `cluster` is present exactly when the target is `your-cluster`, and it is assembled by the
 * provisioning job from APW-06's `AppRuntimeTargetPort.prepareDependencyTarget(workId)` — never by a
 * provider parsing a kubeconfig itself, and never by this epic (plan §4.8:547-557). Preparation is
 * what makes the namespace, its `LimitRange` and the three baseline network policies exist before a
 * provider runs, which is why **a provider never waits for and never dispatches a Deployment**
 * (GAP-06 / APW07-G01).
 */
export interface AppDependencyContext {
	readonly workId: string;
	readonly appName: string;
	readonly target: AppDependencyTarget;
	/** The App spec block for this kind (non-secret) — `{ version, extensions }`, `{ buckets }`, … */
	readonly declared: Record<string, unknown>;
	/** The owner's chosen size, when the kind has a volume (FR-37). */
	readonly sizeGiB?: number;
	readonly cluster?: {
		readonly kubeconfig: string;
		readonly context: string | null;
		readonly namespace: string;
		readonly appLabels: Record<string, string>;
	};
	/** The decrypted configuration an external provider was configured with. */
	readonly config?: Record<string, string>;
	/** What this row already produced, so a `refresh` can tell whether anything moved. */
	readonly previousOutputs?: Record<string, string>;
	/** The plugin's resolved settings (`appDependencyStorageClass`, image overrides, …). */
	readonly settings: Record<string, unknown>;
	/** Aborted at the kind's readiness deadline (FR-41) — providers must honour it. */
	readonly signal: AbortSignal;
	/**
	 * R-10: a verification namespace. The same objects with `emptyDir` instead of every PVC, the
	 * plain path always (nothing may outlive the namespace), and the outputs returned to the caller
	 * **in memory and never stored** (FR-60, plan §4.9:621-623).
	 */
	readonly ephemeral?: boolean;
}

/**
 * A plugin that can serve App dependency kinds (plan §4.7:514-533).
 *
 * `isAppDependencyProvider` is the guard every consumer uses — a plugin declares the capability in
 * its manifest, and the registry is asked for that capability, but the METHODS are what a caller
 * actually needs, so the guard is checked on the materialised plugin rather than trusted from the
 * manifest string alone.
 */
export interface IAppDependencyProvider extends IPlugin {
	readonly dependencyProviders: readonly AppDependencyProviderDescriptor[];
	supports(
		kind: AppDependencyKind,
		target: AppDependencyTarget,
		ctx: AppDependencyContext
	): Promise<AppDependencySupport>;
	provision(providerId: string, ctx: AppDependencyContext): Promise<AppDependencyProvisionOutcome>;
	/** Re-read what the dependency publishes — the `refresh` mode of the provisioning job. */
	getOutputs(providerId: string, ctx: AppDependencyContext): Promise<Record<string, string>>;
	/**
	 * Release, or destroy, what the provider created (plan §4.7:523-528, §4.12).
	 *
	 * `deleteData: false` makes **no cluster call** and answers `released`; with
	 * `stopWorkloads: true` (App Work deletion, R-15) it scales the dependency's workloads to 0 and
	 * touches nothing else — no PVC, no Secret, no network policy.
	 */
	deprovision(
		providerId: string,
		ctx: AppDependencyContext,
		opts: AppDependencyDeprovisionOptions
	): Promise<AppDependencyDeprovisionOutcome>;
	/** FR-48/FR-49 — the card's one backup state, read from individual records, never a summary. */
	backupStatus(providerId: string, ctx: AppDependencyContext): Promise<AppDependencyBackupStatus>;
}

/**
 * Is this plugin an App dependency provider?
 *
 * The capability is checked on the plugin's own `capabilities` array, and the two methods a caller
 * cannot do without are checked as functions — the lazy-plugin proxy over-reports optional members,
 * so a `typeof` guard on the real methods is what makes the answer trustworthy (the same reasoning
 * `git.facade.ts` records for the optional git capabilities).
 */
export function isAppDependencyProvider(plugin: IPlugin): plugin is IAppDependencyProvider {
	if (!plugin || !Array.isArray(plugin.capabilities)) return false;
	if (!plugin.capabilities.includes('app-dependency')) return false;
	const candidate = plugin as Partial<IAppDependencyProvider>;
	return (
		Array.isArray(candidate.dependencyProviders) &&
		typeof candidate.supports === 'function' &&
		typeof candidate.provision === 'function' &&
		typeof candidate.deprovision === 'function'
	);
}
