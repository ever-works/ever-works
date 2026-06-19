import { Injectable, Logger } from '@nestjs/common';
import type { SecretStoreResolver } from './secret-store-resolver.interface';

/**
 * EW-742 P3.2 follow-up — HashiCorp Vault implementation of the
 * {@link SecretStoreResolver} contract.
 *
 * Supports pointers of the form `vault:<path>` where `<path>` is the
 * Vault REST path AFTER `/v1/`. Examples:
 *
 *   - `vault:secret/tenants/acme/temporal` — KV v1 at
 *     `${VAULT_ADDR}/v1/secret/tenants/acme/temporal`
 *   - `vault:secret/data/tenants/acme/trigger` — KV v2 at
 *     `${VAULT_ADDR}/v1/secret/data/tenants/acme/trigger` (note the
 *     `data/` segment in KV v2 paths)
 *
 * # KV version auto-detection
 *
 * Vault KV v1 returns `{ data: { key1: val1, ... } }` and KV v2 returns
 * `{ data: { data: { key1: val1, ... }, metadata: {...} } }`. This
 * resolver tries KV v2 first (`json.data?.data` is a non-null object),
 * falls back to KV v1 (`json.data` is a non-null object). Operators can
 * use either mount type without changing the resolver.
 *
 * # Configuration
 *
 * Reads from `process.env`:
 *
 *   - `VAULT_ADDR` — Vault server URL (e.g. `https://vault.internal:8200`)
 *   - `VAULT_TOKEN` — token with read permission for the requested paths
 *
 * Both env vars are read at every {@link resolve} call (not cached) so
 * operators can rotate the token at runtime without process restart.
 * Missing either returns `null` + `Logger.warn` (fail-open per contract).
 *
 * # Wiring
 *
 * This class is NOT registered in any DI module by default — the
 * `TenantJobRuntimeModule` keeps `InProcessSecretStoreResolver` as the
 * default `SECRET_STORE_RESOLVER` binding. Operators using Vault should
 * override the binding in their own application module:
 *
 *   ```ts
 *   @Module({
 *     providers: [
 *       VaultSecretStoreResolver,
 *       { provide: SECRET_STORE_RESOLVER, useClass: VaultSecretStoreResolver },
 *     ],
 *   })
 *   ```
 *
 * # Fail-open semantics
 *
 * Per the {@link SecretStoreResolver} contract, every failure path
 * returns `null` + `Logger.warn` — never throws. The resolver above
 * (TenantAwareRuntimeResolver) falls back to the instance default on
 * null, so an unreachable Vault never blocks an enqueue.
 *
 * Uses Node 22+ global `fetch` — no new npm dependency.
 */
@Injectable()
export class VaultSecretStoreResolver implements SecretStoreResolver {
    private readonly logger = new Logger(VaultSecretStoreResolver.name);

    async resolve(pointer: string): Promise<Record<string, unknown> | null> {
        if (!pointer.startsWith('vault:')) {
            const scheme = pointer.split(':', 1)[0] ?? 'unknown';
            this.logger.warn(
                `VaultSecretStoreResolver: pointer scheme "${scheme}:" not handled by this ` +
                    `resolver. Use VaultSecretStoreResolver only for vault: pointers. Returning ` +
                    `null (fail-open).`,
            );
            return null;
        }

        const path = pointer.slice('vault:'.length);
        if (!path) {
            this.logger.warn(
                `VaultSecretStoreResolver: vault: pointer carries empty path. Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }

        const addr = process.env.VAULT_ADDR;
        const token = process.env.VAULT_TOKEN;
        if (!addr) {
            this.logger.warn(
                `VaultSecretStoreResolver: VAULT_ADDR env var not set. Returning null (fail-open).`,
            );
            return null;
        }
        if (!token) {
            this.logger.warn(
                `VaultSecretStoreResolver: VAULT_TOKEN env var not set. Returning null (fail-open).`,
            );
            return null;
        }

        const url = `${addr.replace(/\/+$/, '')}/v1/${path.replace(/^\/+/, '')}`;

        let response: Response;
        try {
            response = await fetch(url, {
                method: 'GET',
                headers: {
                    'X-Vault-Token': token,
                    Accept: 'application/json',
                },
            });
        } catch (err) {
            this.logger.warn(
                `VaultSecretStoreResolver: fetch failed for ${url} ` +
                    `(${err instanceof Error ? err.message : String(err)}). Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }

        if (!response.ok) {
            this.logger.warn(
                `VaultSecretStoreResolver: Vault responded ${response.status} for ${url}. ` +
                    `Returning null (fail-open).`,
            );
            return null;
        }

        let json: unknown;
        try {
            json = await response.json();
        } catch (err) {
            this.logger.warn(
                `VaultSecretStoreResolver: Vault response is not JSON ` +
                    `(${err instanceof Error ? err.message : String(err)}). Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }

        if (json === null || typeof json !== 'object' || Array.isArray(json)) {
            this.logger.warn(
                `VaultSecretStoreResolver: Vault response is not a JSON object. Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }

        // Try KV v2 first: `{ data: { data: {...}, metadata: {...} } }`.
        // The v2 envelope's inner `.data.data` is the secret bag.
        const outer = (json as { data?: unknown }).data;
        if (outer && typeof outer === 'object' && !Array.isArray(outer)) {
            const v2Inner = (outer as { data?: unknown }).data;
            if (v2Inner && typeof v2Inner === 'object' && !Array.isArray(v2Inner)) {
                return v2Inner as Record<string, unknown>;
            }
            // KV v1: `{ data: {...} }` — the outer `.data` IS the bag.
            return outer as Record<string, unknown>;
        }

        this.logger.warn(
            `VaultSecretStoreResolver: Vault response missing .data field. Returning null ` +
                `(fail-open).`,
        );
        return null;
    }
}
