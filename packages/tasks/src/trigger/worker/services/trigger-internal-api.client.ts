import { Injectable } from '@nestjs/common';
import superjson from 'superjson';
import { config } from '@ever-works/agent/config';
import { WorkContextResponse } from '@ever-works/agent/tasks';

/**
 * Remote calls that are safe to re-issue after a transport failure.
 *
 * **The list is an ALLOW-list and the default is "do not retry."** Omitting a
 * method costs at most one lost retry; adding the wrong one silently doubles a
 * side effect in production, so the polarity is deliberate — when in doubt,
 * leave a method out.
 *
 * Why this exists: a transport failure tells the caller nothing about whether
 * the server ran the work. A client-side deadline does not cancel the API pod,
 * and neither does an nginx 504 or a Cloudflare 524 — the request keeps
 * executing on the other side while the worker gives up on it. Re-issuing the
 * call therefore starts a SECOND execution of work that is very likely already
 * running or already committed. For a pure read that is harmless; for
 * `AgentRunService.execute` it is a second billed agent loop with real tool
 * side effects, which is exactly the case this list exists to prevent.
 *
 * Retries are not the last line of defence: a call that is refused a retry
 * here surfaces as a task failure, and Trigger.dev retries the whole task —
 * where `dedupKey` and the `markStarted` CAS make re-execution safe. That is
 * the right layer for a retry, because it is the layer that has deduplication.
 *
 * A method qualifies only if calling it twice is indistinguishable from
 * calling it once, and that property is STRUCTURAL (a CAS, a dedup key, or an
 * absolute-value SET) rather than incidental. Entries are grouped by which of
 * those two reasons applies. Note `AgentRunRepository.addTokens` is
 * deliberately absent while its sibling `updateTelemetry` is present: the
 * former accumulates, the latter overwrites.
 */
const RETRY_SAFE_REMOTE_METHODS: ReadonlySet<string> = new Set<string>([
    // ── Pure reads — no writes at all. ──────────────────────────────
    'AgentRepository.findById',
    'AgentRepository.findByIdAndUser',
    'AgentRunRepository.findById',
    'AgentRunRepository.findInFlightForAgent',
    'AgentRunRepository.findInFlightForTaskAgent',
    'AgentRunService.checkBudget',
    'TasksService.getOne',
    'WorkRepository.findById',

    // ── Writers whose idempotency is structural. ────────────────────
    // CAS on a non-terminal status: a second call matches zero rows.
    'AgentRunRepository.markCompleted',
    'AgentRunRepository.markFailed',
    'AgentRunRepository.markStarted',
    // Absolute-value SET of an explicit field whitelist; nothing accumulates.
    'AgentRunRepository.updateGateResults',
    'AgentRunRepository.updateTelemetry',
    'AgentRepository.releaseAfterRun',
    // Pointer-CAS of the same (latestRunId, latestRunStatus) pair.
    'TaskRunDenormService.recordQueued',
    'TaskRunDenormService.recordStarted',
    'TaskRunDenormService.recordTerminal',
    // Dedup key with a pre-read plus a UNIQUE-violation re-read.
    'AgentEscalationService.record',
    // Per-user `daily:<userId>:<date>` idempotency key checked before the write.
    'CreditLedgerService.dispatchDailyGrants',
    // Explicit already-marked guard / absolute SET recomputed from the anchor.
    'WorkScheduleService.markRunCompleted',
    'WorkScheduleService.markRunFailed',
]);

@Injectable()
export class TriggerInternalApiClient {
    private readonly baseUrl: string;
    private readonly secret: string;
    private readonly requestTimeoutMs: number;

    constructor() {
        this.baseUrl = config.trigger.getInternalBaseUrl() || '';
        this.secret = config.trigger.getInternalSecret() || '';
        this.requestTimeoutMs = config.trigger.getInternalRequestTimeoutMs();

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
            // A read. Re-issuing it can only cost a duplicate query.
            retryable: true,
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
            // Default-deny. Only a method explicitly declared re-issuable may
            // be retried — see `RETRY_SAFE_REMOTE_METHODS` for why an
            // unlisted method must fail through to the task-level retry.
            retryable: RETRY_SAFE_REMOTE_METHODS.has(`${name}.${method}`),
        });

        return response.result ? superjson.deserialize(response.result as any) : undefined;
    }

    private async request<T>({
        method,
        path,
        body,
        retryable,
    }: {
        method: string;
        path: string;
        body?: unknown;
        /**
         * Whether re-issuing this exact request is safe. `false` collapses the
         * loop to a single attempt — a transport failure then propagates to
         * the caller instead of being silently re-executed.
         */
        retryable: boolean;
    }): Promise<T> {
        const url = this.composeUrl(path);
        const maxRetries = retryable ? 3 : 0;
        const baseDelayMs = 500;

        let lastError: Error | undefined;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                const delay = baseDelayMs * Math.pow(2, attempt - 1);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }

            // One deadline per attempt, covering the response body as well as
            // the headers — a stalled body read hangs the worker just as
            // effectively as a stalled connect. `AbortController` +
            // `setTimeout` rather than `AbortSignal.timeout()`: the former is
            // driven by the suite's fake timers, the latter is not.
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
            timer.unref?.();

            try {
                let response: Response;

                try {
                    response = await fetch(url, {
                        method,
                        headers: {
                            'content-type': 'application/json',
                            'x-trigger-secret': this.secret,
                        },
                        body: body ? JSON.stringify(body) : undefined,
                        signal: controller.signal,
                    });
                } catch (networkError) {
                    lastError = this.describeTransportFailure(networkError, controller.signal);

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

                // Only retry on 5xx server errors. Note this branch is what
                // makes a proxy timeout retryable at all: nginx answers 504 and
                // Cloudflare answers 524, both of which are >= 500 even though
                // the work they timed out on is still running server-side. That
                // is why `retryable` has to gate the loop rather than the
                // status code alone.
                if (response.status < 500 || attempt >= maxRetries) {
                    throw lastError;
                }
            } finally {
                clearTimeout(timer);
            }
        }

        throw lastError ?? new Error('Trigger internal API request failed after retries');
    }

    /**
     * Turn a rejected `fetch` into the error the caller should see. An abort
     * raised by our own deadline is reported as a timeout naming the budget,
     * so an operator reading worker logs can tell "we gave up" apart from
     * "the network refused us". Everything else is passed through unchanged.
     */
    private describeTransportFailure(cause: unknown, signal: AbortSignal): Error {
        if (signal.aborted) {
            return new Error(
                `Trigger internal API request timed out after ${this.requestTimeoutMs}ms`,
            );
        }

        return cause instanceof Error ? cause : new Error(String(cause));
    }

    private composeUrl(path: string): string {
        const trimmedBase = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl;
        const trimmedPath = path.startsWith('/') ? path.slice(1) : path;

        return `${trimmedBase}/${trimmedPath}`;
    }
}
