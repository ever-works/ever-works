import { Injectable, Logger } from '@nestjs/common';
import type { SecretStoreResolver } from './secret-store-resolver.interface';

/**
 * EW-742 P3.2 — default zero-dependency {@link SecretStoreResolver}
 * implementation.
 *
 * Supports two schemes — both zero-dep, both safe to ship as the
 * out-of-the-box default:
 *
 *   - `inline:<base64-of-json>` — credential bag carried in the pointer
 *     itself. Useful for dev / preview / integration tests that need a
 *     deterministic credential without standing up a real secret store.
 *   - `env:<VAR_NAME>` — credential bag stored as the value of
 *     `process.env.<VAR_NAME>` (parsed as JSON). The canonical
 *     production-friendly path for self-hosters who already inject
 *     credentials via env vars (`.env`, Docker `--env`, k8s `env:`).
 *
 * Every other scheme (`vault:`, `k8s:`, `infisical:`, `doppler:`, etc.)
 * returns `null` + `Logger.warn` so operators see a load-bearing log
 * line on every unresolved enqueue: "we received a pointer we don't
 * know how to resolve — bind a real {@link SecretStoreResolver} for
 * this scheme."
 *
 * # Why these two are the bundled default
 *
 *   - Zero runtime dependencies (no Vault SDK, no kubectl, no
 *     vendor-specific client in the build).
 *   - Cover the two universal "I just want credentials in this
 *     process" cases (carry-with-the-pointer + read-from-env).
 *   - Lets the resolver wire-up land on `main` without committing the
 *     platform to a specific secret-store vendor.
 *   - Vendor-specific resolvers (Vault, k8s, Infisical, Doppler, etc.)
 *     ship as separate `@Injectable()` classes operators opt into by
 *     overriding the `SECRET_STORE_RESOLVER` DI binding.
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
 * **Security note:** `inline:` pointers carry the plaintext credential
 * IN THE POINTER ITSELF. The `tenant_job_runtime_config` table is
 * operator-readable; using `inline:` in production leaks the credential
 * to anyone with DB read access. Prefer `env:` for self-hosters or a
 * dedicated secret-store resolver (Vault / k8s / Infisical / Doppler)
 * for multi-tenant deployments.
 *
 * # `env:` format
 *
 *   `env:<VAR_NAME>` — `VAR_NAME` is the name of an env var whose value
 *   is a JSON-encoded object. Example:
 *
 *   ```bash
 *   # operator sets:
 *   export TENANT_ACME_TRIGGER='{"accessToken":"tr_dev_xxx","region":"us-east-1"}'
 *   ```
 *
 *   ```
 *   # tenant pointer:
 *   env:TENANT_ACME_TRIGGER
 *   ```
 *
 * The resolver reads `process.env[VAR_NAME]` and parses it as JSON. The
 * env var name is the only thing stored in the DB; the actual credential
 * value never leaves the operator's `.env` / Docker / k8s injection
 * pipeline. This is the recommended path for self-hosters who manage
 * credentials with the standard 12-factor env-var pattern.
 *
 * **Note:** `env:` is read at every `resolve()` call so operators can
 * rotate the value at runtime by re-injecting the env var (e.g. via a
 * pod rolling restart). The platform's per-tenant `credentialVersion`
 * still bumps explicitly via the rotate endpoint.
 */
@Injectable()
export class InProcessSecretStoreResolver implements SecretStoreResolver {
    private readonly logger = new Logger(InProcessSecretStoreResolver.name);

    async resolve(pointer: string): Promise<Record<string, unknown> | null> {
        if (pointer.startsWith('inline:')) {
            return this.resolveInline(pointer.slice('inline:'.length));
        }
        if (pointer.startsWith('env:')) {
            return this.resolveEnv(pointer.slice('env:'.length));
        }

        const scheme = pointer.split(':', 1)[0] ?? 'unknown';
        this.logger.warn(
            `InProcessSecretStoreResolver: pointer scheme "${scheme}:" is not ` +
                `supported by the default resolver. Bind a concrete SecretStoreResolver ` +
                `for this scheme via the SECRET_STORE_RESOLVER DI token. Returning null ` +
                `(fail-open — resolver falls back to instance default).`,
        );
        return null;
    }

    private resolveInline(encoded: string): Record<string, unknown> | null {
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

        return this.parseJsonObject(decoded, 'inline:');
    }

    private resolveEnv(varName: string): Record<string, unknown> | null {
        if (!varName) {
            this.logger.warn(
                `InProcessSecretStoreResolver: env: pointer carries empty var name. ` +
                    `Returning null (fail-open).`,
            );
            return null;
        }

        const raw = process.env[varName];
        if (raw === undefined) {
            this.logger.warn(
                `InProcessSecretStoreResolver: env: pointer references undefined env var ` +
                    `"${varName}". Ensure the operator has injected it (e.g. via .env, Docker ` +
                    `--env, k8s env:). Returning null (fail-open).`,
            );
            return null;
        }
        if (raw === '') {
            this.logger.warn(
                `InProcessSecretStoreResolver: env: pointer references empty env var ` +
                    `"${varName}". Returning null (fail-open).`,
            );
            return null;
        }

        return this.parseJsonObject(raw, `env:${varName}`);
    }

    private parseJsonObject(source: string, label: string): Record<string, unknown> | null {
        let parsed: unknown;
        try {
            parsed = JSON.parse(source);
        } catch (err) {
            this.logger.warn(
                `InProcessSecretStoreResolver: ${label} payload is not valid JSON ` +
                    `(${err instanceof Error ? err.message : String(err)}). Returning null (fail-open).`,
            );
            return null;
        }

        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            const got = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
            this.logger.warn(
                `InProcessSecretStoreResolver: ${label} payload must be a JSON object ` +
                    `(got ${got}). Returning null (fail-open).`,
            );
            return null;
        }

        return parsed as Record<string, unknown>;
    }
}
