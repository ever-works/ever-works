import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { createHmac } from 'crypto';
import { firstValueFrom } from 'rxjs';
import type { AxiosError, AxiosResponse } from 'axios';
import type { Work } from '@ever-works/agent/entities';
import { PlatformSyncSecretService } from '@ever-works/agent/services';
import { isSafeWebhookUrl } from '@ever-works/agent/utils';
import type { DirectorySiteEntry, FeedCategory, FeedEntry } from './dto/feed-entry.dto';
import type { FeedDegradedReason } from './dto/feed-response.dto';

const REQUEST_TIMEOUT_MS = 5000;
const MAX_DRIFT_MS = 5 * 60 * 1000;
// Security: upper bound on the upstream-supplied `summary` string. The directory
// site is tenant-controlled (and could be compromised), so a malicious deploy
// could return a multi-megabyte or control-char-laden summary that bloats the
// feed payload or, if the value ever reaches an LLM prompt / log line, smuggles
// injected instructions. Cap length and strip control characters server-side.
const MAX_SUMMARY_LENGTH = 500;

export type DirectoryFeedFetchParams = {
    since?: string;
    limit: number;
    types: DirectoryEntryType[];
};

export type DirectoryEntryType = 'users' | 'items' | 'reports' | 'all';

export type DirectoryFeedResult =
    | { ok: true; entries: DirectorySiteEntry[]; nextCursor: string | null }
    | { ok: false; degraded: FeedDegradedReason };

type UpstreamEntry = {
    id: string;
    type: DirectorySiteEntry['type'];
    timestamp: string;
    summary: string;
    actor?: { id: string; name: string; email?: string | null } | null;
    target: {
        id: string;
        type: DirectorySiteEntry['target']['type'];
        name: string;
        adminUrl: string;
    };
};

type UpstreamResponse = {
    entries: UpstreamEntry[];
    nextCursor?: string | null;
    serverTime: string;
};

/**
 * Client for the deployed directory site's `/api/platform/activity-feed`
 * endpoint. Handles HMAC signing, timeouts, retries, and graceful degradation
 * — never throws: callers always get either a success payload or a typed
 * `degraded` reason they can surface to the UI.
 *
 * See `docs/specs/features/activity-feed-per-directory/plan.md` §5.1 and §10.
 */
@Injectable()
export class DirectoryWebsiteClient {
    private readonly logger = new Logger(DirectoryWebsiteClient.name);

    constructor(
        private readonly httpService: HttpService,
        private readonly secretService: PlatformSyncSecretService,
    ) {}

    async fetchActivityFeed(
        work: Work,
        params: DirectoryFeedFetchParams,
    ): Promise<DirectoryFeedResult> {
        // EW-120 dual-mode: this client is the pull transport. It must only
        // run for `activitySyncMode === 'pull'`. Callers (ActivityFeedService)
        // gate on the mode before invoking the client, but we re-check here
        // to avoid silently hitting the network if a stale `Work` slipped
        // through (e.g. mode flipped between authorisation and fetch).
        if (work.activitySyncMode !== 'pull') {
            return degraded('disabled');
        }
        if (!work.website) {
            return degraded('not_provisioned', 'Work has no deployed website URL');
        }

        let secret: string | null;
        try {
            secret = this.secretService.decryptForWork(work);
        } catch (err) {
            this.logger.warn(
                `decryptForWork failed for work ${work.id}: ${(err as Error).message}`,
            );
            return degraded('parse_error', 'Secret could not be decrypted');
        }
        if (!secret) {
            return degraded('not_provisioned');
        }

        return this.fetchWithRetry(work, params, secret);
    }

    private async fetchWithRetry(
        work: Work,
        params: DirectoryFeedFetchParams,
        secret: string,
    ): Promise<DirectoryFeedResult> {
        let lastDegraded: FeedDegradedReason = { reason: 'network' };
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const outcome = await this.tryOnce(work, params, secret);
            if (outcome.ok === true) {
                return outcome;
            }
            const reason = outcome.degraded as FeedDegradedReason;
            if (isPermanent(reason.reason)) {
                return outcome;
            }
            lastDegraded = reason;
            // 200ms backoff before retry.
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return { ok: false, degraded: lastDegraded };
    }

    private async tryOnce(
        work: Work,
        params: DirectoryFeedFetchParams,
        secret: string,
    ): Promise<DirectoryFeedResult> {
        const timestamp = new Date().toISOString();
        const queryString = serialiseQuery(params);
        const url = `${stripTrailingSlash(work.website!)}/api/platform/activity-feed${queryString ? `?${queryString}` : ''}`;

        // Security (SSRF + signed-bearer leak): `work.website` is
        // attacker-influenceable (a tenant's verified custom domain is promoted
        // into it by the deploy facade), and every request below carries an HMAC
        // `Authorization: Bearer` header binding the per-Work signing secret. A
        // host that points at a private/loopback/link-local or cloud-metadata
        // address (e.g. 169.254.169.254 / metadata.google.internal) must never be
        // contacted, and the signed header must never be sent to it. Reuse the
        // shared lexical SSRF guard already used by WebhookDeliveryService. We
        // refuse BEFORE computing/sending the signature so the secret never
        // leaves the process for an unsafe target. Local dev/test may legitimately
        // point a Work at http://localhost, so — mirroring webhooks.service.ts —
        // the guard is enforced in every non-local env (staging/prod share network
        // reach to internal tooling and cloud metadata).
        const env = process.env.NODE_ENV;
        const isLocalEnv =
            env === 'development' || env === 'test' || env === undefined || env === '';
        if (!isLocalEnv && !isSafeWebhookUrl(url)) {
            this.logger.warn(
                `directory-site request blocked by SSRF guard for work ${work.id} (host resolves to a private / loopback / link-local / metadata target)`,
            );
            return degraded('not_provisioned', 'Website URL rejected by SSRF guard');
        }

        // The work ID binds the HMAC to a specific Work so a leaked signature
        // can't be replayed against another Work hosted on the same domain.
        const signature = sign(timestamp, queryString, work.id, secret);

        try {
            const response = await firstValueFrom(
                this.httpService.get<UpstreamResponse>(url, {
                    headers: {
                        Authorization: `Bearer ${signature}`,
                        'x-platform-ts': timestamp,
                        'User-Agent': 'ever-works-platform/activity-feed',
                    },
                    timeout: REQUEST_TIMEOUT_MS,
                }),
            );
            return this.parseResponse(response);
        } catch (err) {
            return this.translateError(err as AxiosError, work.id);
        }
    }

    private parseResponse(response: AxiosResponse<UpstreamResponse>): DirectoryFeedResult {
        const body = response.data;
        if (!body || !Array.isArray(body.entries)) {
            return degraded('parse_error', 'Response shape unexpected');
        }
        const serverTime = body.serverTime ? Date.parse(body.serverTime) : NaN;
        if (Number.isFinite(serverTime) && Math.abs(Date.now() - serverTime) > MAX_DRIFT_MS) {
            return degraded('parse_error', 'Upstream server time drift exceeds 5 minutes');
        }
        const entries: FeedEntry[] = body.entries.map((entry) => mapEntry(entry));
        return {
            ok: true,
            entries: entries as DirectorySiteEntry[],
            nextCursor: body.nextCursor ?? null,
        };
    }

    private translateError(err: AxiosError, workId: string): DirectoryFeedResult {
        if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
            return degraded('timeout');
        }
        const status = err.response?.status;
        if (status === 401 || status === 403) {
            this.logger.warn(
                `directory-site rejected request for work ${workId} (status ${status}); secret may be stale`,
            );
            return degraded('unauthorized');
        }
        if (status && status >= 500) {
            // A directory site that is UP but whose platform-sync env
            // (PLATFORM_SYNC_SECRET) was never injected — e.g. a Work revived /
            // hand-deployed outside the platform deploy flow — answers this
            // endpoint with 503 {"error":"platform sync not configured on this
            // directory"}. That is NOT an outage: the site serves normally, only
            // the activity-feed integration isn't wired yet. Classify it as the
            // benign, already-translated `not_provisioned` state (UI: "events not
            // yet available" + "redeploy the directory site") instead of falsely
            // reporting the live site as unreachable ("Upstream 5xx"). Any other
            // 5xx (a genuinely failing/overloaded site) stays `upstream_5xx`.
            const bodyText =
                typeof err.response?.data === 'string'
                    ? err.response.data
                    : JSON.stringify(err.response?.data ?? '');
            if (status === 503 && /platform sync not configured/i.test(bodyText)) {
                return degraded(
                    'not_provisioned',
                    'Deployed site is up; activity sync is not configured on it yet',
                );
            }
            return degraded('upstream_5xx', `Upstream ${status}`);
        }
        if (status && status >= 400) {
            return degraded('parse_error', `Upstream ${status}`);
        }
        // Security (info leak): raw Axios messages embed internal IPs/hostnames
        // (e.g. `connect ECONNREFUSED 10.96.0.1:443`) and `degraded.detail` is
        // serialised to the browser via FeedResponse. Keep the full message
        // server-side in the log and return a static, safe detail string.
        this.logger.warn(`directory-site network error for work ${workId}: ${err.message}`);
        return degraded('network', 'Network error');
    }
}

function categoryFor(type: DirectorySiteEntry['type']): FeedCategory {
    switch (type) {
        case 'user_registered':
            return 'users';
        case 'item_created':
        case 'item_status_changed':
            return 'submissions';
        case 'report_created':
            return 'reports';
    }
}

function mapEntry(entry: UpstreamEntry): DirectorySiteEntry {
    return {
        id: entry.id,
        source: 'directory-site',
        type: entry.type,
        category: categoryFor(entry.type),
        timestamp: entry.timestamp,
        summary: sanitiseSummary(entry.summary),
        actor: entry.actor ?? null,
        target: entry.target,
    };
}

// Security: harden the tenant-controlled upstream `summary` before it is stored
// and surfaced. Strip ASCII/Unicode control characters (keeps it from injecting
// line-control / escape sequences into logs or downstream prompts) and cap the
// length so a malicious directory site cannot bloat the feed payload.
function sanitiseSummary(value: string): string {
    if (typeof value !== 'string') {
        return '';
    }
    // eslint-disable-next-line no-control-regex
    const stripped = value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
    return stripped.length > MAX_SUMMARY_LENGTH ? stripped.slice(0, MAX_SUMMARY_LENGTH) : stripped;
}

function serialiseQuery(params: DirectoryFeedFetchParams): string {
    const pairs: [string, string][] = [];
    if (params.since) {
        pairs.push(['since', params.since]);
    }
    pairs.push(['limit', String(params.limit)]);
    pairs.push(['types', params.types.join(',')]);
    pairs.sort(([a], [b]) => a.localeCompare(b));
    return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

function sign(timestamp: string, queryString: string, workId: string, secret: string): string {
    return createHmac('sha256', secret)
        .update(`${timestamp}:${queryString}:${workId}`)
        .digest('hex');
}

function stripTrailingSlash(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

function degraded(reason: FeedDegradedReason['reason'], detail?: string): DirectoryFeedResult {
    return { ok: false, degraded: { reason, detail } };
}

function isPermanent(reason: FeedDegradedReason['reason']): boolean {
    return (
        reason === 'not_provisioned' ||
        reason === 'disabled' ||
        reason === 'unauthorized' ||
        reason === 'parse_error'
    );
}
