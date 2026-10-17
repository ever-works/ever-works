/**
 * EW-P3-2 — Knowledge Base DTOs of the integration contract v1 (B.6 "KB"): the
 * `data` of `kb.document.*` / `kb.folder.*` events and the bodies of
 * `GET /kb/documents[/:id]` and `GET /kb/folders[/:id]`.
 *
 * Kept apart from `integration-dto.types.ts` so the KB slice does not touch the
 * P1/P2 resource types.
 */

/** Where a document lives: the organization library, or one Work's knowledge base. */
export interface IntegrationKbScope {
	readonly type: 'organization' | 'work';
	readonly id: string;
}

/**
 * One Knowledge Base document (`work_knowledge_documents`): Markdown with
 * `[[path]]` wikilinks, filed in an organization library folder or Unfiled.
 *
 * Not a `IntegrationResourceBase`: a document has no owner, visibility or teams
 * of its own — it is readable by everyone who can read its organization (an
 * organization document) or its Work (a Work document).
 *
 * Change detection: `revision` moves only on a real change to the title,
 * description, tags, class or body; `normalizedContentHash` fingerprints the
 * body (whitespace-insensitive). `version` moves on EVERY recorded change
 * (status, review, lock, folder, …) and is the `ETag`.
 */
export interface IntegrationKbDocumentDto {
	readonly id: string;
	/** The organization the document belongs to (a Work document: its Work's organization). */
	readonly organizationId: string;
	readonly version: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly scope: IntegrationKbScope;
	/** Set for a Work document (`scope.type === 'work'`), else null. */
	readonly workId: string | null;
	/** The organization library folder it is filed in; null = Unfiled. */
	readonly folderId: string | null;
	/** Relative to the knowledge base root, e.g. `brand/voice.md`. */
	readonly path: string;
	readonly slug: string;
	readonly title: string;
	readonly description: string | null;
	/** Document class (`brand`, `legal`, `seo`, `style`, `glossary`, …, `freeform`, `decision`). */
	readonly class: string;
	readonly tags: readonly string[];
	readonly categories: readonly string[];
	readonly status: 'draft' | 'active' | 'archived';
	/** `proposed` = agent-written and waiting for a person; null on rows that predate review. */
	readonly reviewState: 'proposed' | 'accepted' | null;
	readonly locked: boolean;
	readonly lockMode: 'full' | 'additions-only' | null;
	readonly language: string;
	/** `user` | `agent` | `imported` | `seeded` (open set). */
	readonly source: string;
	/**
	 * The Markdown body. `null` with `bodyOmitted: true` only in an event whose
	 * body exceeds the event body limit; `GET /kb/documents/:id` always carries it.
	 */
	readonly body: string | null;
	readonly bodyOmitted?: true;
	readonly revision: number;
	readonly revisionAt: string | null;
	readonly normalizedContentHash: string | null;
	/** The decision lifecycle of a `decision`-class document (read-only), else null. */
	readonly decision: Readonly<Record<string, unknown>> | null;
	readonly createdById: string | null;
	readonly updatedById: string | null;
	readonly archivedAt: string | null;
	readonly wordCount: number | null;
	readonly webUrl?: string | null;
	/** Only on `kb.document.deleted`. */
	readonly deleted?: true;
}

/** One organization library folder (`memory_folders`, scope `organization`). */
export interface IntegrationKbFolderDto {
	readonly id: string;
	readonly organizationId: string;
	readonly version: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly name: string;
	/** null = a top-level folder. */
	readonly parentId: string | null;
	/** The folder chain, e.g. `/Playbooks/Support`. */
	readonly path: string;
	/** The person who created it. */
	readonly createdById: string;
	readonly webUrl?: string | null;
	/** Only on `kb.folder.deleted`. */
	readonly deleted?: true;
}
