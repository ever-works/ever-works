import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { Agent } from 'https';
import type { SecretStoreResolver } from './secret-store-resolver.interface';

/**
 * EW-742 P3.2 follow-up — Kubernetes Secret implementation of the
 * {@link SecretStoreResolver} contract.
 *
 * Supports pointers of the form:
 *
 *   - `k8s:<secretName>` — uses the pod's own namespace (read from
 *     `/var/run/secrets/kubernetes.io/serviceaccount/namespace`)
 *   - `k8s:<namespace>/<secretName>` — explicit namespace
 *
 * # In-cluster requirements
 *
 * Reads from the service account mounted at
 * `/var/run/secrets/kubernetes.io/serviceaccount/`:
 *
 *   - `token` — Bearer token for the API server (every pod gets one)
 *   - `ca.crt` — CA cert for verifying the API server's TLS
 *   - `namespace` — default namespace (used when pointer omits one)
 *
 * Plus env vars set by kubelet:
 *
 *   - `KUBERNETES_SERVICE_HOST` — API server IP
 *   - `KUBERNETES_SERVICE_PORT` — API server port (usually 443)
 *
 * Missing any of these returns `null` + `Logger.warn` (fail-open per
 * contract). Running OUT-of-cluster is the most common reason — local
 * dev should use `inline:` via {@link InProcessSecretStoreResolver}
 * instead.
 *
 * # Secret decoding
 *
 * Kubernetes Secrets store every value as base64. This resolver
 * decodes each `.data[key]` value back to UTF-8 and returns the result
 * as a flat `Record<string, string>`. Binary secrets that don't
 * round-trip cleanly through UTF-8 should be base64-encoded one extra
 * time before storing — that's the kubernetes-native pattern.
 *
 * # Wiring
 *
 * NOT registered in any DI module by default. Operators using
 * Kubernetes Secrets override the `SECRET_STORE_RESOLVER` binding in
 * their own application module:
 *
 *   ```ts
 *   @Module({
 *     providers: [
 *       K8sSecretStoreResolver,
 *       { provide: SECRET_STORE_RESOLVER, useClass: K8sSecretStoreResolver },
 *     ],
 *   })
 *   ```
 *
 * Composite pattern: a deployment that uses BOTH Vault and k8s Secrets
 * (e.g. operator-managed credentials in Vault, tenant-managed in k8s)
 * can write a thin chain-of-responsibility resolver that dispatches by
 * scheme prefix.
 *
 * Uses Node 22+ global `fetch`, `fs/promises.readFile`, and built-in
 * `https.Agent` for CA-pinned TLS. No new npm dependency.
 */
@Injectable()
export class K8sSecretStoreResolver implements SecretStoreResolver {
    private readonly logger = new Logger(K8sSecretStoreResolver.name);

    private static readonly SA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount';

    async resolve(pointer: string): Promise<Record<string, unknown> | null> {
        if (!pointer.startsWith('k8s:')) {
            const scheme = pointer.split(':', 1)[0] ?? 'unknown';
            this.logger.warn(
                `K8sSecretStoreResolver: pointer scheme "${scheme}:" not handled by this ` +
                    `resolver. Use K8sSecretStoreResolver only for k8s: pointers. Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }

        const rest = pointer.slice('k8s:'.length);
        if (!rest) {
            this.logger.warn(
                `K8sSecretStoreResolver: k8s: pointer carries empty payload. Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }

        const host = process.env.KUBERNETES_SERVICE_HOST;
        const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
        if (!host) {
            this.logger.warn(
                `K8sSecretStoreResolver: KUBERNETES_SERVICE_HOST env var not set. ` +
                    `Running OUT-of-cluster — use inline: via InProcessSecretStoreResolver for ` +
                    `local dev. Returning null (fail-open).`,
            );
            return null;
        }

        // Parse <ns>/<name> or just <name>.
        let namespace: string;
        let name: string;
        const slashIdx = rest.indexOf('/');
        if (slashIdx >= 0) {
            namespace = rest.slice(0, slashIdx);
            name = rest.slice(slashIdx + 1);
            if (!namespace || !name) {
                this.logger.warn(
                    `K8sSecretStoreResolver: malformed pointer "${pointer}" (expected ` +
                        `k8s:<name> or k8s:<ns>/<name>). Returning null (fail-open).`,
                );
                return null;
            }
        } else {
            name = rest;
            const ns = await this.readSaFile('namespace');
            if (!ns) {
                return null;
            }
            namespace = ns.trim();
        }

        const token = await this.readSaFile('token');
        if (!token) {
            return null;
        }
        const ca = await this.readSaFile('ca.crt');
        if (!ca) {
            return null;
        }

        const url = `https://${host}:${port}/api/v1/namespaces/${namespace}/secrets/${name}`;
        const agent = new Agent({ ca });

        let response: Response;
        try {
            response = await fetch(url, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${token.trim()}`,
                    Accept: 'application/json',
                },
                // @ts-expect-error — Node's undici fetch accepts an https.Agent via `dispatcher`.
                // Type defs don't expose it but runtime supports it.
                dispatcher: agent,
            });
        } catch (err) {
            this.logger.warn(
                `K8sSecretStoreResolver: fetch failed for ${url} ` +
                    `(${err instanceof Error ? err.message : String(err)}). Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }

        if (!response.ok) {
            this.logger.warn(
                `K8sSecretStoreResolver: API responded ${response.status} for ${url}. ` +
                    `Returning null (fail-open).`,
            );
            return null;
        }

        let json: unknown;
        try {
            json = await response.json();
        } catch (err) {
            this.logger.warn(
                `K8sSecretStoreResolver: API response is not JSON ` +
                    `(${err instanceof Error ? err.message : String(err)}). Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }

        if (json === null || typeof json !== 'object' || Array.isArray(json)) {
            this.logger.warn(
                `K8sSecretStoreResolver: API response is not a JSON object. Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }

        const data = (json as { data?: unknown }).data;
        if (data === undefined || data === null) {
            // No data field — return empty bag (a Secret with stringData
            // pre-converted to data, or an empty Secret).
            return {};
        }
        if (typeof data !== 'object' || Array.isArray(data)) {
            this.logger.warn(
                `K8sSecretStoreResolver: API response .data is not an object. Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }

        // Decode each base64-encoded value to UTF-8.
        const decoded: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
            if (typeof value !== 'string') {
                continue;
            }
            try {
                decoded[key] = Buffer.from(value, 'base64').toString('utf8');
            } catch {
                // Skip entries that can't be base64-decoded — should never
                // happen for a real k8s Secret but defend anyway.
                continue;
            }
        }
        return decoded;
    }

    private async readSaFile(name: string): Promise<string | null> {
        try {
            return await readFile(`${K8sSecretStoreResolver.SA_PATH}/${name}`, 'utf8');
        } catch (err) {
            this.logger.warn(
                `K8sSecretStoreResolver: failed to read ${name} from service account mount ` +
                    `(${err instanceof Error ? err.message : String(err)}). Returning null ` +
                    `(fail-open).`,
            );
            return null;
        }
    }
}
