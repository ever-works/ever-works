/**
 * Knowledge Base shared types.
 *
 * Centralized here so the same enum / type aliases can be used by:
 *  - the Knowledge Base entities (`work-knowledge-*.entity.ts`)
 *  - the KnowledgeBaseService and downstream services (in `services/`)
 *  - DTOs in `@ever-works/contracts/kb/*`
 *
 * Keep this file thin — schema-level types only. Behaviour belongs in
 * `services/knowledge-base.service.ts`.
 */

/**
 * Typed classification of a KB document. Drives how the agent runtime
 * treats the document (see `docs/specs/features/knowledge-base/spec.md`
 * §10.1 for per-class agent semantics).
 *
 * `brand`        — soft guidance (brand voice, visual identity, tone)
 * `legal`        — verbatim-or-omitted (privacy, terms, regulated copy)
 * `seo`          — constraints (keyword strategy, structured-data conventions)
 * `style`        — editorial style guide (grammar, banned words, voice/tense)
 * `glossary`     — term substitution rules
 * `competitors`  — inclusion/exclusion list for comparison generator
 * `personas`     — audience definitions
 * `research`     — long-form reference material (extracted PDFs etc.)
 * `output`       — agent-authored artifacts (reports, decks, dashboards)
 * `freeform`     — catch-all user notes
 */
export enum KbDocumentClass {
    BRAND = 'brand',
    LEGAL = 'legal',
    SEO = 'seo',
    STYLE = 'style',
    GLOSSARY = 'glossary',
    COMPETITORS = 'competitors',
    PERSONAS = 'personas',
    RESEARCH = 'research',
    OUTPUT = 'output',
    FREEFORM = 'freeform',
}

/**
 * Classes that may be authored at the organization level and inherited
 * (with Work-level override) by every Work in the org. In v1 this is
 * restricted to legal / style / seo. Brand identity is always per-Work.
 */
export const KB_ORG_INHERITABLE_CLASSES: ReadonlyArray<KbDocumentClass> = [
    KbDocumentClass.LEGAL,
    KbDocumentClass.STYLE,
    KbDocumentClass.SEO,
] as const;

export type KbInheritableClass = (typeof KB_ORG_INHERITABLE_CLASSES)[number];

/**
 * Lifecycle status of a KB document. Mirrors the `status` enums on
 * other content-bearing entities (items, comparisons) for consistency.
 */
export enum KbDocumentStatus {
    DRAFT = 'draft',
    ACTIVE = 'active',
    ARCHIVED = 'archived',
}

/**
 * Lock semantics for a document. `full` blocks every mutation;
 * `additions-only` permits appends but not rewrites. Null when the
 * document is unlocked.
 */
export enum KbLockMode {
    FULL = 'full',
    ADDITIONS_ONLY = 'additions-only',
}

/**
 * Source attribution for a KB document. `seeded` is reserved for
 * documents the platform creates automatically on Work init.
 */
export enum KbDocumentSource {
    USER = 'user',
    AGENT = 'agent',
    IMPORTED = 'imported',
    SEEDED = 'seeded',
}

/**
 * Lifecycle of an upload's extraction pipeline. See spec §9 for the
 * receive → normalize → extract → materialize → index sequence.
 */
export enum KbUploadExtractionStatus {
    PENDING = 'pending',
    RUNNING = 'running',
    SUCCEEDED = 'succeeded',
    FAILED = 'failed',
    SKIPPED = 'skipped',
}

/**
 * Polymorphic consumer type for citation rows. Matches the
 * `consumerType` discriminator on `WorkKnowledgeCitation`.
 */
export enum KbCitationConsumerType {
    AGENT_RUN = 'agent-run',
    GENERATION_HISTORY = 'generation-history',
    CONVERSATION_MESSAGE = 'conversation-message',
    COMMUNITY_PR = 'community-pr',
    COMPARISON = 'comparison',
}

/**
 * Per-class inheritance mode for a Work, stored inside
 * `Work.kbConfig.inheritance`. `inherit` (default) merges org + Work
 * with Work overriding for the same path. `override` ignores org-level
 * docs. `disabled` drops the class entirely from agent context.
 */
export type KbInheritanceMode = 'inherit' | 'override' | 'disabled';

/**
 * Per-Work Knowledge Base configuration. Stored as a `simple-json`
 * column on the `works` table. Folded into the existing
 * `Work.kbConfig` field rather than spread across multiple columns
 * because none of these fields are query-driven.
 */
export interface WorkKbConfig {
    /** Disable the KB for this Work entirely. Default `true`. */
    enabled?: boolean;

    /**
     * Override the Work's default storage plugin for KB originals only.
     * If unset, falls back to `Work.storageProvider`.
     */
    storagePluginId?: string;

    /** Path template for original uploads. Default `kb-originals/`. */
    originalsBasePath?: string;

    /** Retrieval-time budget + class-filter knobs. */
    retrievalConfig?: {
        /** Hard cap on retrieved documents. Default 12. */
        maxContextDocs?: number;
        /** Hard cap on retrieved tokens. Default 8000. */
        maxContextTokens?: number;
        /** Restrict retrieval to a subset of classes. */
        classFilters?: KbDocumentClass[];
    };

    /** Per-class org-level inheritance mode. */
    inheritance?: {
        legal?: KbInheritanceMode;
        style?: KbInheritanceMode;
        seo?: KbInheritanceMode;
    };
}
