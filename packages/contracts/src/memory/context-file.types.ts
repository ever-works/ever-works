/**
 * Context files — authored prose injected into runs rather than retrieved.
 *
 * Two families: six **workspace context files** shared by every agent, and
 * the per-agent files. A context file is not a fact (facts are atomic and
 * recalled when relevant) and not a Knowledge Base document (documents are
 * chunked, embedded and cited). Its value is that it arrives whether or not
 * anything retrieved it.
 *
 * Only the shared vocabulary ships with the facts tier; the files themselves,
 * their editor and their load meter build on these values.
 */

/** The fixed set of workspace context files. No create, no delete, no rename. */
export const WORKSPACE_CONTEXT_FILE_SLUGS = [
	'about-you',
	'organization',
	'people',
	'glossary',
	'voice',
	'roster'
] as const;
export type WorkspaceContextFileSlug = (typeof WORKSPACE_CONTEXT_FILE_SLUGS)[number];

/** `always` loads on every run; `onDemand` is fetched by the agent when needed. */
export const CONTEXT_FILE_LOAD_MODES = ['always', 'onDemand'] as const;
export type ContextFileLoadMode = (typeof CONTEXT_FILE_LOAD_MODES)[number];

/** Default load mode per workspace context file. */
export const WORKSPACE_CONTEXT_FILE_DEFAULT_LOAD_MODES: Readonly<
	Record<WorkspaceContextFileSlug, ContextFileLoadMode>
> = {
	'about-you': 'always',
	organization: 'onDemand',
	people: 'onDemand',
	glossary: 'onDemand',
	voice: 'always',
	roster: 'onDemand'
};

/** Most workspace context files that may load on every run at once. */
export const MAX_ALWAYS_LOADED_WORKSPACE_FILES = 3;
/** Revisions kept per file regardless of age. */
export const CONTEXT_FILE_REVISION_KEEP = 20;
/** Every revision younger than this many days is kept as well. */
export const CONTEXT_FILE_REVISION_KEEP_DAYS = 30;

/** Narrowing guard for a slug arriving from a route param. */
export function isWorkspaceContextFileSlug(value: unknown): value is WorkspaceContextFileSlug {
	return typeof value === 'string' && (WORKSPACE_CONTEXT_FILE_SLUGS as readonly string[]).includes(value);
}

/** One workspace context file as the API projects it. */
export interface ContextFileDto {
	slug: WorkspaceContextFileSlug;
	body: string;
	loadMode: ContextFileLoadMode;
	contentHash: string;
	bodyBytes: number;
	updatedByUserId: string | null;
	updatedByAgentId: string | null;
	updatedAt: string;
}
