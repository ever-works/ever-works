import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { createHmac } from 'crypto';
import { firstValueFrom } from 'rxjs';
import type { AxiosError, AxiosResponse } from 'axios';
import type { Work } from '@ever-works/agent/entities';
import { PlatformSyncSecretService } from '@ever-works/agent/services';
import type { DirectorySiteEntry, FeedCategory, FeedEntry } from './dto/feed-entry.dto';
import type { FeedDegradedReason } from './dto/feed-response.dto';

const REQUEST_TIMEOUT_MS = 5000;
const MAX_DRIFT_MS = 5 * 60 * 1000;

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
        // The work ID binds the HMAC to a specific Work so a leaked signature
        // can't be replayed against another Work hosted on the same domain.
        const signature = sign(timestamp, queryString, work.id, secret);
        const url = `${stripTrailingSlash(work.website!)}/api/platform/activity-feed${queryString ? `?${queryString}` : ''}`;

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
            return degraded('upstream_5xx', `Upstream ${status}`);
        }
        if (status && status >= 400) {
            return degraded('parse_error', `Upstream ${status}`);
        }
        return degraded('network', err.message);
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
        summary: entry.summary,
        actor: entry.actor ?? null,
        target: entry.target,
    };
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
