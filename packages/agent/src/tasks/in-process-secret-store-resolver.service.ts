import { Injectable, Logger } from '@nestjs/common';
import type { SecretStoreResolver } from './secret-store-resolver.interface';

/**
 * EW-742 P3.2 — default {@link SecretStoreResolver} implementation.
 *
 * Supports ONE scheme, `inline:`, which carries a base64-encoded JSON
 * object directly in the pointer string. Useful for:
 *   - dev / preview deployments that don't have a real secret store;
 *   - integration tests that need a deterministic credential without
 *     standing up Vault / k8s Secrets / 1Password;
 *   - operators evaluating the tenant overlay before wiring a
 *     production secret store.
 *
 * Every other scheme (`vault:`, `k8s:`, `op:`, etc.) returns `null` +
 * `Logger.warn` so operators see a load-bearing log line on every
 * unresolved enqueue: "we received a pointer we don't know how to
 * resolve — the run is falling back to the instance default and you
 * need to bind a real {@link SecretStoreResolver} for this scheme."
 *
 * # Why this is the bundled default
 *
 *   - Zero runtime dependencies (no Vault SDK, no kubectl, no
 *     1Password CLI in the build).
 *   - Lets the contract land + the resolver wire-up land on `main`
 *     without committing the platform to a specific secret-store
 *     vendor.
 *   - Bundled implementations for the four major schemes ship as
 *     follow-up PRs (one per scheme) so a deployment can opt in by
 *     swapping the DI binding — no rip-and-replace.
 *
 * # `inline:` format
 *
 *   `inline:<base64-of-utf8-json-object>`
 *
 * Example:
 *
 *   ```ts
 *   const credentials = { accessToken: 'tr_dev_xxx', region: 'us-east-1' };
 *   const pointer = `inline:${Buffer.from(JSON.stringify(credentials), 'utf8').toString('base64')}`;
 *   // → 'inline:eyJhY2Nlc3NUb2tlbiI6InRyX2Rldl94eHgiLCJyZWdpb24iOiJ1cy1lYXN0LTEifQ=='
 *   ```
 *
 * The resolver decodes the base64, parses as JSON, and returns the
 * resulting object if it's a non-null record. Anything else (invalid
 * base64, non-JSON, non-object, array, null) returns `null` + a
 * specific `Logger.warn` so operators can fix the pointer.
 *
 * **Security note:** `inline:` pointers carry the plaintext credential
 * IN THE POINTER ITSELF. The platform's `tenant_job_runtime_config`
 * table is operator-readable; using `inline:` in production leaks the
 * credential to anyone with DB read access. The default implementation
 * tolerates it for dev convenience — production deployments should
 * use Vault / k8s / 1Password schemes via a non-default resolver.
 */
@Injectable()
export class InProcessSecretStoreResolver implements SecretStoreResolver {
    private readonly logger = new Logger(InProcessSecretStoreResolver.name);

    async resolve(pointer: string): Promise<Record<string, unknown> | null> {
        if (!pointer.startsWith('inline:')) {
            // Operator wired a non-inline scheme but no concrete resolver
            // for it. Fail-open: log + null so resolver falls back to
            // instance default.
            const scheme = pointer.split(':', 1)[0] ?? 'unknown';
            this.logger.warn(
                `InProcessSecretStoreResolver: pointer scheme "${scheme}:" is not ` +
                    `supported by the default resolver. Bind a concrete SecretStoreResolver ` +
                    `for this scheme via the SECRET_STORE_RESOLVER DI token. Returning null ` +
                    `(fail-open — resolver falls back to instance default).`,
            );
            return null;
        }

        const encoded = pointer.slice('inline:'.length);
        if (!encoded) {
            this.logger.warn(
                `InProcessSecretStoreResolver: inline: pointer carries empty payload. ` +
                    `Returning null (fail-open).`,
            );
            return null;
        }

        let decoded: string;
        try {
            decoded = Buffer.from(encoded, 'base64').toString('utf8');
        } catch (err) {
            this.logger.warn(
                `InProcessSecretStoreResolver: inline: pointer base64-decode failed ` +
                    `(${err instanceof Error ? err.message : String(err)}). Returning null (fail-open).`,
            );
            return null;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(decoded);
        } catch (err) {
            this.logger.warn(
                `InProcessSecretStoreResolver: inline: payload is not valid JSON ` +
                    `(${err instanceof Error ? err.message : String(err)}). Returning null (fail-open).`,
            );
            return null;
        }

        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            this.logger.warn(
                `InProcessSecretStoreResolver: inline: payload must be a JSON object ` +
                    `(got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}). ` +
                    `Returning null (fail-open).`,
            );
            return null;
        }

        return parsed as Record<string, unknown>;
    }
}
