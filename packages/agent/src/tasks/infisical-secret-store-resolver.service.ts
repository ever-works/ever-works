import { Injectable, Logger } from '@nestjs/common';
import type { SecretStoreResolver } from './secret-store-resolver.interface';

/**
 * EW-742 P3.2 follow-up — Infisical implementation of the
 * {@link SecretStoreResolver} contract.
 *
 * [Infisical](https://infisical.com) is an OSS secrets-management
 * platform (self-hostable + SaaS). This resolver fetches a folder of
 * secrets via the Infisical REST API and returns them as a flat
 * credential bag.
 *
 * # Pointer format
 *
 *   `infisical:<workspaceId>/<environment>/<secretPath>`
 *
 * Where:
 *   - `workspaceId` — the Infisical project / workspace UUID
 *   - `environment` — the env slug (e.g. `prod`, `staging`)
 *   - `secretPath` — folder path; everything from the second `/` to end
 *     of pointer. Leading `/` is optional. Examples:
 *
 *     - `infisical:ws-abc/prod/tenants/acme` →
 *       workspace `ws-abc`, env `prod`, path `/tenants/acme`
 *     - `infisical:ws-abc/prod/` →
 *       workspace `ws-abc`, env `prod`, path `/` (root)
 *
 * The resolver fetches every secret under that path and returns them as
 * `{ <secretKey>: <secretValue>, ... }`. Sub-folders are NOT recursed
 * — operators put all credential fields in one folder per tenant.
 *
 * # Configuration
 *
 * Reads from `process.env`:
 *
 *   - `INFISICAL_TOKEN` — service token or Machine Identity token with
 *     read access to the requested paths.
 *   - `INFISICAL_HOST` (optional) — base URL for self-hosted Infisical
 *     instances. Defaults to `https://app.infisical.com`.
 *
 * Both env vars are read at every {@link resolve} call so operators can
 * rotate the token at runtime via pod rolling restart without code
 * changes. Missing `INFISICAL_TOKEN` returns `null` + `Logger.warn`
 * (fail-open per contract).
 *
 * # Wiring
 *
 * NOT registered in any DI module by default. Operators using Infisical
 * override the `SECRET_STORE_RESOLVER` binding in their own application
 * module:
 *
 *   ```ts
 *   @Module({
 *     providers: [
 *       InfisicalSecretStoreResolver,
 *       { provide: SECRET_STORE_RESOLVER, useClass: InfisicalSecretStoreResolver },
 *     ],
 *   })
 *   ```
 *
 * # Fail-open semantics
 *
 * Every failure path returns `null` + `Logger.warn` — never throws.
 * `TenantAwareRuntimeResolver` falls back to the instance default on
 * null, so an unreachable Infisical instance never blocks an enqueue.
 *
 * Uses Node 22+ global `fetch` — no new npm dependency.
 *
 * # API reference
 *
 * - List secrets: `GET /api/v3/secrets/raw?workspaceId=...&environment=...&secretPath=...`
 *   Returns `{ secrets: [{ secretKey, secretValue, ... }, ...] }`.
 *
 *   See https://infisical.com/docs/api-reference/endpoints/secrets/list
 */
@Injectable()
export class InfisicalSecretStoreResolver implements SecretStoreResolver {
    private readonly logger = new Logger(InfisicalSecretStoreResolver.name);

    private static readonly DEFAULT_HOST = 'https://app.infisical.com';

    async resolve(pointer: string): Promise<Record<string, unknown> | null> {
        if (!pointer.startsWith('infisical:')) {
            const scheme = pointer.split(':', 1)[0] ?? 'unknown';
            this.logger.warn(
                `InfisicalSecretStoreResolver: pointer scheme "${scheme}:" not handled by this ` +
                    `resolver. Use InfisicalSecretStoreResolver only for infisical: pointers. ` +
                    `Returning null (fail-open).`,
            );
            return null;
        }

        const rest = pointer.slice('infisical:'.length);
        const parsed = this.parsePointer(rest);
        if (!parsed) {
            this.logger.warn(
                `InfisicalSecretStoreResolver: malformed pointer "${pointer}" (expected ` +
                    `infisical:<workspaceId>/<env>/<path>). Returning null (fail-open).`,
            );
            return null;
        }

        const token = process.env.INFISICAL_TOKEN;
        if (!token) {
            this.logger.warn(
                `InfisicalSecretStoreResolver: INFISICAL_TOKEN env var not set. Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }

        const host = (
            process.env.INFISICAL_HOST ?? InfisicalSecretStoreResolver.DEFAULT_HOST
        ).replace(/\/+$/, '');
        const url =
            `${host}/api/v3/secrets/raw?workspaceId=${encodeURIComponent(parsed.workspaceId)}` +
            `&environment=${encodeURIComponent(parsed.environment)}` +
            `&secretPath=${encodeURIComponent(parsed.secretPath)}`;

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
                `InfisicalSecretStoreResolver: fetch failed for ${url} ` +
                    `(${err instanceof Error ? err.message : String(err)}). Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }

        if (!response.ok) {
            this.logger.warn(
                `InfisicalSecretStoreResolver: Infisical responded ${response.status} for ${url}. ` +
                    `Returning null (fail-open).`,
            );
            return null;
        }

        let json: unknown;
        try {
            json = await response.json();
        } catch (err) {
            this.logger.warn(
                `InfisicalSecretStoreResolver: Infisical response is not JSON ` +
                    `(${err instanceof Error ? err.message : String(err)}). Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }

        if (json === null || typeof json !== 'object' || Array.isArray(json)) {
            this.logger.warn(
                `InfisicalSecretStoreResolver: Infisical response is not a JSON object. ` +
                    `Returning null (fail-open).`,
            );
            return null;
        }

        const secrets = (json as { secrets?: unknown }).secrets;
        if (!Array.isArray(secrets)) {
            this.logger.warn(
                `InfisicalSecretStoreResolver: Infisical response missing .secrets array. ` +
                    `Returning null (fail-open).`,
            );
            return null;
        }

        const bag: Record<string, unknown> = {};
        for (const secret of secrets) {
            if (!secret || typeof secret !== 'object') continue;
            const key = (secret as { secretKey?: unknown }).secretKey;
            const value = (secret as { secretValue?: unknown }).secretValue;
            if (typeof key === 'string' && typeof value === 'string') {
                bag[key] = value;
            }
        }
        return bag;
    }

    private parsePointer(
        rest: string,
    ): { workspaceId: string; environment: string; secretPath: string } | null {
        // Expect at least two slashes: <workspaceId>/<env>/<path>
        // path can be empty (root folder) — pointer ends with trailing slash.
        const firstSlash = rest.indexOf('/');
        if (firstSlash <= 0) return null;
        const workspaceId = rest.slice(0, firstSlash);
        const afterWs = rest.slice(firstSlash + 1);
        const secondSlash = afterWs.indexOf('/');
        if (secondSlash <= 0) return null;
        const environment = afterWs.slice(0, secondSlash);
        const pathRaw = afterWs.slice(secondSlash + 1);
        // Normalise path: ensure leading slash for the API; empty path → '/'.
        const secretPath = pathRaw ? (pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`) : '/';
        return { workspaceId, environment, secretPath };
    }
}
