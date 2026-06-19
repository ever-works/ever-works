import type { IPlugin } from '../plugin.interface.js';

/**
 * EW-742 P3.2 follow-up -- pluggable secret-store-resolver backends.
 *
 * Resolves an opaque `credentialsSecretRef` pointer string (stored in
 * `tenant_job_runtime_config.credentialsSecretRef`) into the plaintext
 * credential bag a job-runtime provider needs to bind a tenant via
 * `provider.bindToTenant(snapshot)` (EW-686 P2 contract).
 *
 * # Pointer format
 *
 * Pointers are `<scheme>:<scheme-specific-payload>`. The scheme picks
 * which `ISecretStoreProvider` resolves it. Bundled schemes:
 *
 *   - `inline:<base64-of-json>` -- credential bag carried in the pointer
 *     (dev / test only; the value lives in the DB row, so production
 *     deployments should prefer a real secret store).
 *   - `env:<VAR_NAME>` -- read `process.env[VAR_NAME]` as JSON. Default
 *     production-friendly path for self-hosters using the standard
 *     12-factor env-var pattern.
 *   - `vault:<path>` -- HashiCorp Vault KV v1 / v2.
 *   - `k8s:<name>` or `k8s:<ns>/<name>` -- Kubernetes Secret via the
 *     in-cluster API.
 *   - `infisical:<workspaceId>/<env>/<path>` -- Infisical (OSS,
 *     self-hostable + SaaS).
 *   - `doppler:<project>/<config>` -- Doppler (freemium SaaS).
 *
 * Additional schemes (AWS Secrets Manager, GCP Secret Manager, Azure
 * Key Vault, etc.) ship as separate `@Injectable()` plugin packages
 * under `packages/plugins/secret-store-<vendor>/`.
 *
 * # Capability strings
 *
 *   - `secret-store-resolve` (required) -- implementations declare this
 *     in their plugin manifest under `everworks.plugin.capabilities`.
 *
 * # Selector
 *
 * The active resolver is picked at boot via the
 * `EVER_WORKS_SECRET_STORE_RESOLVER` env var (one of: `in-process`,
 * `vault`, `k8s`, `infisical`, `doppler`, ...). Defaults to
 * `in-process` (covers `inline:` + `env:`). The in-process default
 * lives in `packages/agent/src/tasks/in-process-secret-store-resolver.service.ts`
 * and is NOT a plugin package -- its two schemes have zero external
 * deps and ship as the platform's fallback.
 *
 * # Fail-open contract
 *
 * Implementations MUST NOT throw on missing / malformed pointers or
 * unreachable backends. Return `null` + `Logger.warn` instead.
 * `TenantAwareRuntimeResolver` falls back to the instance default on
 * `null`, so an unreachable secret store NEVER blocks an enqueue.
 *
 * Why fail-open: a tenant's BYO overlay row depending on Vault
 * shouldn't take down work generation if Vault is briefly unreachable.
 * The platform logs at `warn`, falls back to the instance default
 * credentials, and the operator gets a load-bearing log line to
 * diagnose. This trades momentary correctness for availability -- the
 * tenant runbook (`TENANT_JOB_RUNTIME.md`) calls out the trade.
 */
export interface ISecretStoreProvider extends IPlugin {
	/**
	 * Resolve an opaque pointer to a plaintext credential bag.
	 *
	 * @param pointer scheme-prefixed string from
	 *   `tenant_job_runtime_config.credentialsSecretRef`. Implementations
	 *   inspect the prefix and return `null` (fail-open) for schemes
	 *   they don't handle.
	 * @returns the credential bag, or `null` on any failure (missing
	 *   scheme support, missing config, network error, malformed
	 *   response). MUST NOT throw -- per the fail-open contract above.
	 */
	resolveSecret(pointer: string): Promise<Record<string, unknown> | null>;
}

/**
 * Capability string a secret-store plugin manifest declares under
 * `everworks.plugin.capabilities`. Single capability today -- the
 * resolver does one thing (`resolveSecret`).
 */
export const SECRET_STORE_CAPABILITIES = {
	RESOLVE: 'secret-store-resolve'
} as const;

export type SecretStoreCapability = (typeof SECRET_STORE_CAPABILITIES)[keyof typeof SECRET_STORE_CAPABILITIES];
