import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProductChangelogReadRepository, UserRepository } from '@ever-works/agent/database';
import {
    CHANGELOG_CATEGORIES,
    CHANGELOG_LIMITS,
    type ChangelogCategory,
    type ChangelogEntryDto,
    type ChangelogListResponseDto,
    type ChangelogMarkReadResponseDto,
} from '@ever-works/contracts/api';
import { CHANGELOG_ENTRY_SOURCE, type ChangelogEntrySource } from './changelog-entry-source';
import {
    compareByDateDesc,
    compareForDisplay,
    validateChangelogEntries,
    type ChangelogCatalogEntry,
} from './changelog-entry.validation';

/** Spec FR-31 — the loaded entry list is reused for at most this long. */
export const CHANGELOG_SOURCE_CACHE_TTL_MS = 300_000;

export interface ChangelogListOptions {
    category?: ChangelogCategory;
    limit?: number;
    cursor?: string;
}

/**
 * What's new (AW-14) — the product changelog as one person sees it.
 *
 * Entries come from the bound {@link ChangelogEntrySource}; only per-person
 * read state is persisted. Every method is keyed by the person and never by
 * a workspace scope (spec FR-13).
 *
 * Visibility rules, applied on every request against the API's own clock
 * (never the client's — spec FR-7):
 *  - a future-dated entry is invisible: not listed, not counted, not
 *    resolvable by slug;
 *  - only the newest {@link CHANGELOG_LIMITS.listMax} published entries are
 *    reachable at all (spec FR-27);
 *  - an entry published before the person's account existed counts as read
 *    with no row written (spec FR-14).
 */
@Injectable()
export class ChangelogService {
    private readonly logger = new Logger(ChangelogService.name);
    private loaded: { at: number; entries: ChangelogCatalogEntry[] } | null = null;
    private inflight: Promise<ChangelogCatalogEntry[]> | null = null;

    constructor(
        @Inject(CHANGELOG_ENTRY_SOURCE) private readonly source: ChangelogEntrySource,
        private readonly reads: ProductChangelogReadRepository,
        private readonly users: UserRepository,
    ) {}

    /** `GET /api/changelog` — one page, plus the unfiltered count and chip state. */
    async list(
        userId: string,
        options: ChangelogListOptions = {},
        now: Date = new Date(),
    ): Promise<ChangelogListResponseDto> {
        const [visible, accountCreatedAt] = await Promise.all([
            this.visibleEntries(now),
            this.accountCreatedAt(userId, now),
        ]);

        const limit = clampLimit(options.limit);
        const filtered = options.category
            ? visible.filter((entry) => entry.category === options.category)
            : visible;

        let start = 0;
        if (options.cursor !== undefined) {
            const index = filtered.findIndex((entry) => entry.slug === options.cursor);
            // An unknown cursor (an entry a newer deploy removed, or a
            // tampered value) yields an empty last page rather than restarting
            // from the top, which would hand the client duplicates.
            start = index === -1 ? filtered.length : index + 1;
        }
        const page = filtered.slice(start, start + limit);
        const hasMore = start + limit < filtered.length;

        const [readSlugs, unreadCount] = await Promise.all([
            this.reads.findReadSlugs(
                userId,
                page
                    .filter((entry) => entry.publishedAt > accountCreatedAt)
                    .map((entry) => entry.slug),
            ),
            this.countUnread(userId, visible, accountCreatedAt),
        ]);

        const present = new Set(visible.map((entry) => entry.category));
        return {
            entries: page.map((entry) => toDto(entry, isRead(entry, accountCreatedAt, readSlugs))),
            nextCursor: hasMore && page.length > 0 ? page[page.length - 1].slug : null,
            total: visible.length,
            unreadCount,
            categoriesWithEntries: CHANGELOG_CATEGORIES.filter((category) => present.has(category)),
        };
    }

    /**
     * `GET /api/changelog/:slug` — `null` for an entry this build does not
     * have AND for one that is still scheduled, so the endpoint cannot be used
     * to discover unreleased work (spec S-15).
     */
    async getBySlug(
        userId: string,
        slug: string,
        now: Date = new Date(),
    ): Promise<ChangelogEntryDto | null> {
        const visible = await this.visibleEntries(now);
        const entry = visible.find((candidate) => candidate.slug === slug);
        if (!entry) {
            return null;
        }
        const accountCreatedAt = await this.accountCreatedAt(userId, now);
        const readSlugs =
            entry.publishedAt > accountCreatedAt
                ? await this.reads.findReadSlugs(userId, [entry.slug])
                : new Set<string>();
        return toDto(entry, isRead(entry, accountCreatedAt, readSlugs));
    }

    /** `GET /api/changelog/unread-count` (spec FR-15). */
    async unreadCount(userId: string, now: Date = new Date()): Promise<number> {
        const [visible, accountCreatedAt] = await Promise.all([
            this.visibleEntries(now),
            this.accountCreatedAt(userId, now),
        ]);
        return this.countUnread(userId, visible, accountCreatedAt);
    }

    /**
     * `POST /api/changelog/read` — idempotent (spec FR-18). Slugs this build
     * does not serve (unknown, removed, or still scheduled) are ignored so a
     * client racing a deploy never errors; entries that already count as read
     * through the signup baseline need no row.
     */
    async markRead(
        userId: string,
        slugs: readonly string[],
        now: Date = new Date(),
    ): Promise<ChangelogMarkReadResponseDto> {
        const [visible, accountCreatedAt] = await Promise.all([
            this.visibleEntries(now),
            this.accountCreatedAt(userId, now),
        ]);
        const wanted = new Set(slugs);
        const toWrite = visible
            .filter((entry) => wanted.has(entry.slug) && entry.publishedAt > accountCreatedAt)
            .map((entry) => entry.slug);
        await this.reads.markRead(userId, toWrite);
        return { unreadCount: await this.countUnread(userId, visible, accountCreatedAt) };
    }

    /**
     * `POST /api/changelog/read-all` — every entry visible to this person,
     * regardless of any category filter the client has on screen (spec
     * FR-19). One INSERT, so a throttled or failed call changes nothing.
     */
    async markAllRead(
        userId: string,
        now: Date = new Date(),
    ): Promise<ChangelogMarkReadResponseDto> {
        const [visible, accountCreatedAt] = await Promise.all([
            this.visibleEntries(now),
            this.accountCreatedAt(userId, now),
        ]);
        await this.reads.markRead(
            userId,
            visible
                .filter((entry) => entry.publishedAt > accountCreatedAt)
                .map((entry) => entry.slug),
        );
        return { unreadCount: 0 };
    }

    /** Published entries in display order, capped at the list maximum. */
    private async visibleEntries(now: Date): Promise<ChangelogCatalogEntry[]> {
        const all = await this.catalogue(now);
        return all.filter((entry) => entry.publishedAt <= now).slice(0, CHANGELOG_LIMITS.listMax);
    }

    /**
     * Spec FR-15 — unread among the newest {@link CHANGELOG_LIMITS.unreadWindow}
     * published entries that are newer than the account. Read rows for slugs
     * outside that set (including entries a later build removed) are ignored.
     */
    private async countUnread(
        userId: string,
        visible: readonly ChangelogCatalogEntry[],
        accountCreatedAt: Date,
    ): Promise<number> {
        const candidates = [...visible]
            .sort(compareByDateDesc)
            .slice(0, CHANGELOG_LIMITS.unreadWindow)
            .filter((entry) => entry.publishedAt > accountCreatedAt)
            .map((entry) => entry.slug);
        return this.reads.countUnread(userId, candidates);
    }

    /**
     * Spec FR-14 — the signup baseline. A person the users table cannot find
     * gets `now`, i.e. nothing unread, rather than a badge counting every entry
     * ever published.
     */
    private async accountCreatedAt(userId: string, now: Date): Promise<Date> {
        const user = await this.users.findById(userId);
        const createdAt = user?.createdAt ? new Date(user.createdAt) : null;
        return createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : now;
    }

    /**
     * The validated, display-ordered entry list, reloaded from the source at
     * most every {@link CHANGELOG_SOURCE_CACHE_TTL_MS}. A failed reload keeps
     * serving the last good list; with no good list yet, the failure
     * propagates so the reader sees a retryable error, not a false "no
     * updates yet".
     */
    private async catalogue(now: Date): Promise<ChangelogCatalogEntry[]> {
        const fresh = this.loaded && now.getTime() - this.loaded.at < CHANGELOG_SOURCE_CACHE_TTL_MS;
        if (this.loaded && fresh) {
            return this.loaded.entries;
        }
        if (!this.inflight) {
            this.inflight = this.loadFromSource(now).finally(() => {
                this.inflight = null;
            });
        }
        try {
            return await this.inflight;
        } catch (error) {
            if (this.loaded) {
                this.logger.warn(
                    `Changelog source "${this.source.id}" failed to reload; serving the previous entries: ${errorMessage(error)}`,
                );
                return this.loaded.entries;
            }
            throw error;
        }
    }

    private async loadFromSource(now: Date): Promise<ChangelogCatalogEntry[]> {
        const records = await this.source.load();
        const { entries, issues } = validateChangelogEntries(records);
        for (const issue of issues) {
            this.logger.warn(
                `Changelog source "${this.source.id}" entry "${issue.slug}": ${issue.problem}${issue.dropped ? ' (entry not served)' : ''}`,
            );
        }
        const ordered = [...entries].sort(compareForDisplay);
        this.loaded = { at: now.getTime(), entries: ordered };
        return ordered;
    }
}

function clampLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) {
        return CHANGELOG_LIMITS.pageSize;
    }
    return Math.min(Math.max(Math.trunc(limit), 1), CHANGELOG_LIMITS.pageSizeMax);
}

function isRead(
    entry: ChangelogCatalogEntry,
    accountCreatedAt: Date,
    readSlugs: Set<string>,
): boolean {
    return entry.publishedAt <= accountCreatedAt || readSlugs.has(entry.slug);
}

function toDto(entry: ChangelogCatalogEntry, read: boolean): ChangelogEntryDto {
    return {
        slug: entry.slug,
        title: entry.title,
        body: entry.body,
        category: entry.category,
        kind: entry.kind,
        publishedAt: entry.publishedAt.toISOString(),
        pinned: entry.pinned,
        cta: entry.cta ? { label: entry.cta.label, href: entry.cta.href } : null,
        isRead: read,
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
