/**
 * EW-742 P3.2 — secret-store-pointer resolution for the tenant overlay.
 *
 * The platform's tenant overlay stores `credentialsSecretRef` as an
 * opaque string pointer (≤128 chars) — e.g. `vault:secret/tenants/acme/temporal`,
 * `k8s:tenant-acme-trigger-credentials`, `op://Vault/Trigger-acme/access-token`,
 * `inline:eyJ...` (base64-encoded JSON, dev/test only). The pointer
 * scheme is operator-specific because the underlying secret-store
 * pipeline lives in the deployment, not the code.
 *
 * The `TenantAwareRuntimeResolver` calls
 * {@link SecretStoreResolver.resolve} when it needs to construct a
 * {@link TenantCredentialSnapshot} for `provider.bindToTenant()` — i.e.
 * when a tenant's overlay row has `mode = 'byo' | 'override'` and
 * `enabled = true`. The resolver's behaviour on `null` is fail-open:
 * fall back to the instance default and log, never block an enqueue
 * because credentials couldn't be resolved.
 *
 * # Why an interface (not a class with conditional branches)
 *
 * The set of supported schemes is operator-controlled. A self-hoster
 * who only uses `inline:` doesn't want the Vault SDK as a runtime
 * dependency; a Vault shop doesn't want the 1Password CLI bundled.
 * The DI binding lets each deployment swap the implementation:
 *
 *   - Default: `InProcessSecretStoreResolver` (this PR) — only
 *     `inline:` works; everything else returns `null` + `Logger.warn`
 *     telling the operator to wire a real implementation.
 *   - Future: per-scheme wrappers (`VaultSecretStoreResolver`,
 *     `K8sSecretStoreResolver`, etc.) under separate plugin packages
 *     or apps/api binding overrides.
 *   - Composite: a chain-of-responsibility resolver that dispatches by
 *     scheme prefix to the right concrete implementation.
 *
 * # Contract
 *
 *   - `resolve(pointer)` MUST return the credential bag as an opaque
 *     `Record<string, unknown>` (the shape is per-provider; the
 *     resolver doesn't interpret it).
 *   - MUST return `null` when:
 *     - the pointer scheme is unknown to this implementation;
 *     - the secret-store lookup itself failed (network, auth, missing
 *       entry, malformed data);
 *     - the resolved value isn't a JSON object.
 *   - MUST NOT throw on missing / malformed pointers — fail-open is the
 *     contract; the caller logs at warn and falls back to the instance
 *     default. Throwing would block enqueue, which the tenant runbook
 *     promises will NEVER happen on overlay misconfiguration.
 *   - SHOULD log at `warn` when returning `null` so operators can
 *     diagnose silent-fallback scenarios from logs alone.
 */
export interface SecretStoreResolver {
    /**
     * Resolves a `credentialsSecretRef` pointer to the credential bag
     * (or `null` — see contract above).
     *
     * @param pointer the opaque pointer string from
     *   {@link TenantJobRuntimeConfig.credentialsSecretRef}.
     *   Will never be `null` / empty when called from the resolver
     *   (only `byo` / `override` rows with `enabled = true` reach this
     *   path).
     */
    resolve(pointer: string): Promise<Record<string, unknown> | null>;
}

/**
 * DI token for the `SecretStoreResolver` binding. Modules MUST provide
 * a concrete implementation:
 *
 *   {@includeCode ../docs/runbooks/TENANT_JOB_RUNTIME.md}
 *   ```ts
 *   { provide: SECRET_STORE_RESOLVER, useClass: InProcessSecretStoreResolver }
 *   ```
 *
 * The token is a `Symbol(...)` rather than a `string` so it can't
 * accidentally collide with a plain-text DI token elsewhere. The
 * unique identity is the value's reference, not the symbol description.
 */
export const SECRET_STORE_RESOLVER = Symbol('SECRET_STORE_RESOLVER');
