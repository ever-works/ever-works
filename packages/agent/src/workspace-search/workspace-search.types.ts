import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import type { WorkspaceSearchKind } from '@ever-works/contracts/api';
import type { OwnershipScope } from '../database/ownership-scope';

/**
 * The caller a search runs for. `tenantId` / `organizationId` are the active
 * request scope — the same `{ tenantId, organizationId }` every other scoped
 * read receives — so results never cross a workspace boundary.
 */
export interface WorkspaceSearchScope extends OwnershipScope {
    userId: string;
}

export interface WorkspaceSearchFilters {
    /** Raw query as typed. */
    query: string;
    /** Restrict to these kinds; empty/omitted means every available kind. */
    kinds?: WorkspaceSearchKind[];
    /** Total rows across all groups. */
    limit?: number;
    /** Rows per group. */
    perKindLimit?: number;
    /** `${kind}:${sourceId}` keys the caller opened recently (ranking boost). */
    recent?: string[];
}

/** One source row projected into the shape ranking and rendering need. */
export interface WorkspaceSearchCandidate {
    kind: WorkspaceSearchKind;
    sourceId: string;
    title: string;
    identifier: string | null;
    /** Matched at the "secondary" band. */
    secondary: string[];
    subtitle: string | null;
    statusLabel: string | null;
    destination: string;
    updatedAt: Date | null;
}

export interface WorkspaceSearchSourceResult {
    candidates: WorkspaceSearchCandidate[];
    /** Rows matching before the candidate cap. */
    total: number;
}

/** What a source receives for one query. */
export interface WorkspaceSearchSourceQuery {
    scope: WorkspaceSearchScope;
    /** Lower-cased, LIKE-escaped `%query%`. */
    containsPattern: string;
    /** Lower-cased, LIKE-escaped in-order subsequence `%q%u%e%r%y%`, or null when too short. */
    subsequencePattern: string | null;
    /**
     * Trimmed, lower-cased query compared for equality. This and the fields
     * below let a source order rows by relevance before the cap, so the cap
     * keeps the best matches rather than merely the newest ones.
     */
    exactValue: string;
    /** Lower-cased, LIKE-escaped `query%`. */
    prefixPattern: string;
    /**
     * Lower-cased, LIKE-escaped "a word starts with the query" patterns
     * (`% query%`, `%-query%`, …); empty when the query itself spans words.
     */
    wordPrefixPatterns: string[];
    /** `${kind}:${sourceId}` keys the caller opened recently. */
    recentKeys: string[];
    /** The instant freshness is measured from. */
    now: Date;
    /** Maximum candidates to read. */
    cap: number;
}

/**
 * Declarative description of one searchable kind. Adding a kind is one
 * definition file plus one line in `sources/index.ts`; the query runner owns
 * matching, scoping, ordering and the cap so no source can drift from the
 * portable LIKE path.
 */
export interface WorkspaceSearchSourceDefinition<T extends ObjectLiteral> {
    kind: WorkspaceSearchKind;
    entity: new () => T;
    /** Query-builder alias; also the prefix of every column below. */
    alias: string;
    /** Display-name property — matched as a substring and as a subsequence. */
    titleColumn: string;
    /** Slug / short reference property. */
    identifierColumn?: string;
    /** Description / path / tag-list properties. */
    secondaryColumns?: string[];
    /**
     * Last-changed property: breaks relevance ties before the cap (newest
     * first) and measures freshness.
     */
    updatedAtColumn?: string;
    /**
     * Restrict rows to what the caller may open. Defaults to
     * `userId = caller` plus the active ownership scope.
     */
    applyAccess?: (qb: SelectQueryBuilder<T>, scope: WorkspaceSearchScope) => void;
    toCandidate: (row: T) => WorkspaceSearchCandidate;
}
