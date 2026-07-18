import { Injectable } from '@nestjs/common';
import superjson from 'superjson';
import { config } from '@ever-works/agent/config';
import { WorkContextResponse } from '@ever-works/agent/tasks';

@Injectable()
export class TriggerInternalApiClient {
    private readonly baseUrl: string;
    private readonly secret: string;

    constructor() {
        this.baseUrl = config.trigger.getInternalBaseUrl() || '';
        this.secret = config.trigger.getInternalSecret() || '';

        if (!this.baseUrl) {
            throw new Error('TRIGGER_INTERNAL_API_URL is not configured');
        }

        // The x-trigger-secret header and decrypted plugin-secret payloads transit this
        // connection. In production, refuse plaintext HTTP over UNTRUSTED (public) networks
        // so they can't leak on the wire. In-cluster service-to-service traffic (the
        // Kubernetes pod network) is exempt: it never leaves the cluster and TLS is
        // terminated at the ingress, so http://<svc>.<ns>.svc.cluster.local is plaintext by
        // design. Non-production (local dev) keeps working unchanged.
        if (
            process.env.NODE_ENV === 'production' &&
            !this.baseUrl.startsWith('https://') &&
            !TriggerInternalApiClient.isInClusterUrl(this.baseUrl)
        ) {
            throw new Error('TRIGGER_INTERNAL_API_URL must use HTTPS');
        }

        if (!this.secret) {
            throw new Error('TRIGGER_INTERNAL_SECRET is not configured');
        }
    }

    /**
     * True when the base URL targets an in-cluster / loopback host, where plaintext
     * http:// is acceptable because the traffic never leaves the trusted pod network:
     * Kubernetes service DNS (a bare single-label service name, *.svc, *.svc.cluster.local),
     * *.local, localhost/loopback, or an RFC1918 / link-local private IP. Public hosts
     * (always fully-qualified) still require https://.
     */
    private static isInClusterUrl(rawUrl: string): boolean {
        let host: string;
        try {
            host = new URL(rawUrl).hostname;
        } catch {
            return false;
        }
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
            return true;
        }
        if (
            host.endsWith('.svc') ||
            host.endsWith('.svc.cluster.local') ||
            host.endsWith('.local')
        ) {
            return true;
        }
        // A bare single-label hostname (no dot) can only be an in-cluster/local name;
        // public hosts are always fully-qualified.
        if (!host.includes('.')) {
            return true;
        }
        // RFC1918 / link-local private IPv4 ranges.
        if (
            /^10\./.test(host) ||
            /^192\.168\./.test(host) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
            /^169\.254\./.test(host)
        ) {
            return true;
        }
        return false;
    }

    async fetchWorkContext(workId: string, userId: string): Promise<WorkContextResponse> {
        const searchParams = new URLSearchParams({ userId });

        return this.request<WorkContextResponse>({
            method: 'GET',
            path: `/works/${workId}/context?${searchParams.toString()}`,
        });
    }

    /**
     * Forward a method call to a named injectable on the API side.
     * Args are passed as a SuperJSON envelope; the result is SuperJSON-deserialized.
     */
    async callRemote(
        name: string,
        method: string,
        args: { json: unknown; meta?: unknown },
    ): Promise<unknown> {
        const response = await this.request<{ result: { json: unknown; meta?: unknown } }>({
            method: 'POST',
            path: '/remote/call',
            body: { name, method, args },
        });

        return response.result ? superjson.deserialize(response.result as any) : undefined;
    }

    private async request<T>({
        method,
        path,
        body,
    }: {
        method: string;
        path: string;
        body?: unknown;
    }): Promise<T> {
        const url = this.composeUrl(path);
        const maxRetries = 3;
        const baseDelayMs = 500;

        let lastError: Error | undefined;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                const delay = baseDelayMs * Math.pow(2, attempt - 1);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }

            let response: Response;

            try {
                response = await fetch(url, {
                    method,
                    headers: {
                        'content-type': 'application/json',
                        'x-trigger-secret': this.secret,
                    },
                    body: body ? JSON.stringify(body) : undefined,
                });
            } catch (networkError) {
                lastError =
                    networkError instanceof Error ? networkError : new Error(String(networkError));

                if (attempt < maxRetries) {
                    continue;
                }

                throw lastError;
            }

            if (response.ok) {
                if (response.status === 204) {
                    return undefined as T;
                }

                const text = await response.text();

                return text ? (JSON.parse(text) as T) : (undefined as T);
            }

            const text = await response.text();
            lastError = new Error(
                `Trigger internal API request failed (${response.status}): ${text}`,
            );

            // Only retry on 5xx server errors
            if (response.status < 500 || attempt >= maxRetries) {
                throw lastError;
            }
        }

        throw lastError ?? new Error('Trigger internal API request failed after retries');
    }

    private composeUrl(path: string): string {
        const trimmedBase = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl;
        const trimmedPath = path.startsWith('/') ? path.slice(1) : path;

        return `${trimmedBase}/${trimmedPath}`;
    }
}
