/**
 * Shared view — the owner-facing wire contracts behind Settings → Sharing and
 * the public share-link exchange.
 *
 * A Shared view is one Workspace's read-only published face: a live,
 * revocable projection of its Task board reached by a share link. It holds
 * WHAT may be read and BY WHICH token, never a copy of the content.
 *
 * Pure types plus closed vocabularies, so the API, the web app and any other
 * client import one definition. Additive-only (this ships in a public package).
 */

/** `active` = the link resolves; `paused` = sharing is off but the link is kept. */
export type SharedViewStatus = 'active' | 'paused';

export const SHARED_VIEW_STATUSES: readonly SharedViewStatus[] = ['active', 'paused'];

export function isSharedViewStatus(value: unknown): value is SharedViewStatus {
	return value === 'active' || value === 'paused';
}

/** Which sections a Shared view publishes. The board is on by default, knowledge off. */
export interface SharedViewSectionsDto {
	board: boolean;
	knowledge: boolean;
}

/** How a Shared view answers crawlers. `blocked` is the default. */
export type SharedViewIndexingMode = 'blocked' | 'allowed';

/** Every number the Shared view contract promises, in one place. */
export const SHARED_VIEW_LIMITS = {
	/** 256 bits of randomness, base64url without padding. */
	tokenBytes: 32,
	tokenLength: 43,
	/** A view session lives this long before the client exchanges the token again. */
	viewSessionTtlSeconds: 15 * 60,
	/** Cards per published column. */
	columnCardLimit: 50,
	/** Lines in the published activity strip. */
	activityLineLimit: 20,
	/** Labels per published card. */
	cardLabelLimit: 3,
	/** Exchanges and reads per token (or per view) per minute. */
	requestsPerTokenPerMinute: 60,
	/** Public requests per client per hour. */
	requestsPerClientPerHour: 600,
	/** Owner regenerations per Workspace per minute. */
	regeneratePerMinute: 10,
	/** A client increments the view count at most once in this window. */
	viewDedupeWindowSeconds: 10 * 60,
	/** The `Retry-After` a throttled public request carries. */
	retryAfterSeconds: 60,
	/** The live poll cadence of the published page. */
	pollIntervalSeconds: 20,
	/** Knowledge class names a selection may hold. */
	knowledgeClassLimit: 32
} as const;

/** The one error message every refused share-link request carries. */
export const SHARED_VIEW_NOT_ACTIVE = 'shared_view_not_active';

/** The share link, returned only to the Tenant owner. */
export interface SharedViewLinkDto {
	/** The 43-character share token. The web app builds `/share/<token>` from it. */
	token: string;
}

/**
 * `GET /api/organizations/:orgId/shared-view` and every owner write.
 *
 * Every member of the Workspace may read the settings; only the Tenant owner
 * receives `link`. `exists: false` means sharing has never been turned on.
 */
export interface SharedViewSettingsDto {
	exists: boolean;
	/** True when the caller is the Tenant owner and may change sharing. */
	canManage: boolean;
	status: SharedViewStatus | null;
	sections: SharedViewSectionsDto;
	/** Knowledge Base classes selected for publication. Empty publishes nothing. */
	knowledgeClasses: string[];
	searchIndexable: boolean;
	viewCount: number;
	/** ISO timestamp, or `null` when the link was never opened. */
	lastViewedAt: string | null;
	/** ISO timestamp of the last regenerate, or `null` when never regenerated. */
	tokenRotatedAt: string | null;
	rotationCount: number;
	/** ISO timestamp the Shared view was first turned on. */
	createdAt: string | null;
	/** Present only for the Tenant owner, and only when the stored token could be read. */
	link: SharedViewLinkDto | null;
	/** True for the owner when a stored token exists but could not be decrypted — regenerate to recover. */
	linkUnreadable: boolean;
}

/** `PATCH /api/organizations/:orgId/shared-view` — every field optional, one facet per field. */
export interface UpdateSharedViewDto {
	status?: SharedViewStatus;
	sections?: Partial<SharedViewSectionsDto>;
	knowledgeClasses?: string[];
	searchIndexable?: boolean;
}

/** `POST /api/public/shared-view/sessions` request body. The token never travels in a URL. */
export interface SharedViewSessionRequestDto {
	token: string;
}

/** `POST /api/public/shared-view/sessions` response. */
export interface SharedViewSessionDto {
	/** Opaque credential presented as `Authorization: Bearer <viewSession>` on every read. */
	viewSession: string;
	/** ISO timestamp after which the view session is refused. */
	expiresAt: string;
	/** Crawler posture of the resolved view, so the page can render its own robots directive. */
	searchIndexable: boolean;
	/** Sections the resolved view publishes. */
	sections: SharedViewSectionsDto;
}

/** Per-class publishable document counts for the knowledge confirm dialog. */
export interface SharedViewKnowledgeClassCountDto {
	documentClass: string;
	count: number;
}
