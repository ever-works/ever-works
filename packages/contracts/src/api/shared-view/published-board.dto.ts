import type { FeedNarrationDto } from '../../feed/feed.types.js';
import type { SharedViewSectionsDto } from './shared-view.dto.js';

/**
 * Shared view — the published board: what a link visitor with no account is
 * allowed to read.
 *
 * Every type below is CLOSED: no index signature, no `Record<string, unknown>`
 * escape hatch, no optional passthrough. A field that is not declared here
 * cannot be serialised, so adding a field to a Task, an Agent or an activity
 * record can never leak it onto the published page.
 *
 * What is deliberately absent, and must stay absent: ids of any kind, costs,
 * budgets, token counts, model names, run references, error text, comments,
 * sub-tasks, the Mission / Work / Idea / Team / Goal a Task is filed against,
 * repositories, file paths, in-product URLs, and every human's name or email.
 */

/** The four published columns — the private Task board's Focus layout, minus Cancelled. */
export type PublishedColumnKey = 'backlog' | 'in_flight' | 'needs_you' | 'done';

export const PUBLISHED_COLUMN_KEYS: readonly PublishedColumnKey[] = ['backlog', 'in_flight', 'needs_you', 'done'];

/** `p0` (Urgent) … `p4` (Low). */
export type PublishedTaskPriority = 'p0' | 'p1' | 'p2' | 'p3' | 'p4';

/** The Agent working a card: a display name only. The page draws the avatar from it. */
export interface PublishedAgentRefDto {
	name: string;
}

export interface PublishedTaskCardDto {
	title: string;
	column: PublishedColumnKey;
	priority: PublishedTaskPriority;
	/** At most three labels. */
	labels: string[];
	/** ISO timestamp the work last moved. */
	lastProgressAt: string;
	/** True when the work has stopped moving (the private board's stall rule). */
	stale: boolean;
	agent: PublishedAgentRefDto | null;
}

export interface PublishedColumnDto {
	key: PublishedColumnKey;
	/** Cards in the column, at most fifty, ordered exactly as on the private board. */
	cards: PublishedTaskCardDto[];
	/** Cards the column holds beyond the published ones — rendered as `+N more`. */
	moreCount: number;
}

/** `working` = has work in flight or a run going; `paused` = paused by its owner; otherwise `idle`. */
export type PublishedAgentStatus = 'working' | 'idle' | 'paused';

export interface PublishedAgentDto {
	name: string;
	status: PublishedAgentStatus;
	/** Published cards this Agent is working in the In flight column. */
	inFlightCount: number;
}

/** Who an activity line is about. Only an Agent is ever named. */
export type PublishedActorKind = 'agent' | 'person' | 'system';

export interface PublishedActivityLineDto {
	actorKind: PublishedActorKind;
	/** The Agent's display name. Always `null` for a person or the system. */
	actorName: string | null;
	/** The same narration the Live Feed renders, with the actor param never naming a person. */
	narration: FeedNarrationDto;
	/** ISO timestamp. */
	at: string;
}

/** `GET /api/public/shared-view/board` */
export interface PublishedBoardDto {
	workspaceName: string;
	sections: SharedViewSectionsDto;
	columns: PublishedColumnDto[];
	agents: PublishedAgentDto[];
	recent: PublishedActivityLineDto[];
	/** ISO timestamp the projection was computed. */
	generatedAt: string;
}
