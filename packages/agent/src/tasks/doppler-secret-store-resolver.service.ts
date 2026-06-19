import { Injectable, Logger } from '@nestjs/common';
import type { SecretStoreResolver } from './secret-store-resolver.interface';

/**
 * EW-742 P3.2 follow-up — Doppler implementation of the
 * {@link SecretStoreResolver} contract.
 *
 * [Doppler](https://doppler.com) is a freemium secrets-management SaaS.
 * This resolver fetches a Doppler config (all secrets in one
 * project + config) via the REST API and returns them as a flat
 * credential bag.
 *
 * # Pointer format
 *
 *   `doppler:<project>/<config>`
 *
 * Where:
 *   - `project` — the Doppler project slug (e.g. `ever-works`)
 *   - `config` — the config slug within that project (e.g. `prd_tenants_acme`)
 *
 * Examples:
 *   - `doppler:ever-works/prd_tenants_acme` — every secret in the
 *     `prd_tenants_acme` config of the `ever-works` project.
 *
 * Operators put one Doppler config per tenant credential bag. The
 * resolver fetches all secrets in that config and returns them as
 * `{ SECRET_NAME: <raw value>, ... }`.
 *
 * # Configuration
 *
 * Reads from `process.env`:
 *
 *   - `DOPPLER_TOKEN` — a Doppler Service Token (read-only is fine) or
 *     Service Account token with access to the requested project/config.
 *
 * Read at every {@link resolve} call so operators can rotate the token
 * at runtime via pod rolling restart without code changes. Missing
 * `DOPPLER_TOKEN` returns `null` + `Logger.warn` (fail-open per contract).
 *
 * # Wiring
 *
 * NOT registered in any DI module by default. Operators using Doppler
 * override the `SECRET_STORE_RESOLVER` binding in their own application
 * module:
 *
 *   ```ts
 *   @Module({
 *     providers: [
 *       DopplerSecretStoreResolver,
 *       { provide: SECRET_STORE_RESOLVER, useClass: DopplerSecretStoreResolver },
 *     ],
 *   })
 *   ```
 *
 * # Fail-open semantics
 *
 * Every failure path returns `null` + `Logger.warn` — never throws.
 * `TenantAwareRuntimeResolver` falls back to the instance default on
 * null, so an unreachable Doppler API never blocks an enqueue.
 *
 * Uses Node 22+ global `fetch` — no new npm dependency.
 *
 * # API reference
 *
 * - List secrets: `GET https://api.doppler.com/v3/configs/config/secrets?project=...&config=...`
 *   Returns `{ secrets: { KEY: { raw: "value", computed: "value", ... }, ... } }`.
 *
 *   See https://docs.doppler.com/reference/secrets-list
 */
@Injectable()
export class DopplerSecretStoreResolver implements SecretStoreResolver {
    private readonly logger = new Logger(DopplerSecretStoreResolver.name);

    private static readonly API_HOST = 'https://api.doppler.com';

    async resolve(pointer: string): Promise<Record<string, unknown> | null> {
        if (!pointer.startsWith('doppler:')) {
            const scheme = pointer.split(':', 1)[0] ?? 'unknown';
            this.logger.warn(
                `DopplerSecretStoreResolver: pointer scheme "${scheme}:" not handled by this ` +
                    `resolver. Use DopplerSecretStoreResolver only for doppler: pointers. ` +
                    `Returning null (fail-open).`,
            );
            return null;
        }

        const rest = pointer.slice('doppler:'.length);
        const parsed = this.parsePointer(rest);
        if (!parsed) {
            this.logger.warn(
                `DopplerSecretStoreResolver: malformed pointer "${pointer}" (expected ` +
                    `doppler:<project>/<config>). Returning null (fail-open).`,
            );
            return null;
        }

        const token = process.env.DOPPLER_TOKEN;
        if (!token) {
            this.logger.warn(
                `DopplerSecretStoreResolver: DOPPLER_TOKEN env var not set. Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }

        const url =
            `${DopplerSecretStoreResolver.API_HOST}/v3/configs/config/secrets` +
            `?project=${encodeURIComponent(parsed.project)}` +
            `&config=${encodeURIComponent(parsed.config)}`;

        let response: Response;
        try {
            response = await fetch(url, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                },
            });
        } catch (err) {
            this.logger.warn(
                `DopplerSecretStoreResolver: fetch failed for ${url} ` +
                    `(${err instanceof Error ? err.message : String(err)}). Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }

        if (!response.ok) {
            this.logger.warn(
                `DopplerSecretStoreResolver: Doppler responded ${response.status} for ${url}. ` +
                    `Returning null (fail-open).`,
            );
            return null;
        }

        let json: unknown;
        try {
            json = await response.json();
        } catch (err) {
            this.logger.warn(
                `DopplerSecretStoreResolver: Doppler response is not JSON ` +
                    `(${err instanceof Error ? err.message : String(err)}). Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }

        if (json === null || typeof json !== 'object' || Array.isArray(json)) {
            this.logger.warn(
                `DopplerSecretStoreResolver: Doppler response is not a JSON object. Returning ` +
                    `null (fail-open).`,
            );
            return null;
        }

        const secrets = (json as { secrets?: unknown }).secrets;
        if (secrets === null || secrets === undefined) {
            // No secrets in config — return empty bag.
            return {};
        }
        if (typeof secrets !== 'object' || Array.isArray(secrets)) {
            this.logger.warn(
                `DopplerSecretStoreResolver: Doppler response .secrets is not an object. ` +
                    `Returning null (fail-open).`,
            );
            return null;
        }

        // Each entry is `{ raw: string, computed: string, ... }`. Prefer
        // the `raw` value (the literal user-set value); fall back to
        // `computed` (server-side substituted) if raw is missing.
        const bag: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(secrets as Record<string, unknown>)) {
            if (!entry || typeof entry !== 'object') continue;
            const raw = (entry as { raw?: unknown }).raw;
            const computed = (entry as { computed?: unknown }).computed;
            if (typeof raw === 'string') {
                bag[key] = raw;
            } else if (typeof computed === 'string') {
                bag[key] = computed;
            }
        }
        return bag;
    }

    private parsePointer(rest: string): { project: string; config: string } | null {
        const slashIdx = rest.indexOf('/');
        if (slashIdx <= 0) return null;
        const project = rest.slice(0, slashIdx);
        const config = rest.slice(slashIdx + 1);
        if (!project || !config) return null;
        return { project, config };
    }
}
