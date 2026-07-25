import type { GenerationRequest, IPipelineContext, PipelineOutputs, WorkReference } from '@ever-works/plugin';
import type {
	GtmActionRecord,
	GtmCampaignReport,
	GtmContact,
	GtmDraft,
	GtmFollowUpItem,
	GtmScoredContact,
	GtmSignal,
	GtmStageDataKey
} from './types.js';

/**
 * Serializable snapshot of the GTM pipeline context — used for
 * stage-boundary checkpoints and resume (including resuming a run that
 * paused at the `review` human gate once approvals arrive).
 */
export interface GtmContextSnapshot {
	readonly work: WorkReference;
	readonly request: GenerationRequest;
	readonly shouldStop?: boolean;
	readonly warnings: string[];
	readonly contacts: GtmContact[];
	readonly signals: GtmSignal[];
	readonly scoredContacts: GtmScoredContact[];
	readonly excludedContacts: GtmScoredContact[];
	readonly drafts: GtmDraft[];
	readonly approvedDrafts: GtmDraft[];
	readonly pendingReview: boolean;
	readonly actionLog: GtmActionRecord[];
	readonly followUpQueue: GtmFollowUpItem[];
	readonly enrichedContacts: GtmContact[];
	readonly report: GtmCampaignReport | null;
}

/**
 * Mutable pipeline context for the GTM stage set. Each stage reads its
 * declared inputs from — and writes its declared outputs to — this
 * context, reproducing auditable stage handoffs.
 */
export class GtmPipelineContext implements IPipelineContext {
	shouldStop?: boolean;
	warnings: string[] = [];

	contacts: GtmContact[] = [];
	signals: GtmSignal[] = [];
	scoredContacts: GtmScoredContact[] = [];
	excludedContacts: GtmScoredContact[] = [];
	drafts: GtmDraft[] = [];
	approvedDrafts: GtmDraft[] = [];
	/** True when the review gate paused the run awaiting human approval. */
	pendingReview = false;
	actionLog: GtmActionRecord[] = [];
	followUpQueue: GtmFollowUpItem[] = [];
	enrichedContacts: GtmContact[] = [];
	report: GtmCampaignReport | null = null;

	constructor(
		public readonly work: WorkReference,
		public request: GenerationRequest
	) {}

	/** Whether a declared stage data key already has a result in this context. */
	hasStageResult(key: GtmStageDataKey): boolean {
		switch (key) {
			case 'contacts':
				return this.contacts.length > 0;
			case 'signals':
				return this.signals.length > 0;
			case 'scored_contacts':
				return this.scoredContacts.length > 0;
			case 'drafts':
				return this.drafts.length > 0;
			case 'approved_drafts':
				return this.approvedDrafts.length > 0;
			case 'action_log':
				return this.actionLog.length > 0;
			case 'follow_up_queue':
				return this.followUpQueue.length > 0;
			case 'enriched_contacts':
				return this.enrichedContacts.length > 0;
			case 'campaign_report':
				return this.report !== null;
		}
	}

	toSnapshot(): GtmContextSnapshot {
		return {
			work: this.work,
			request: this.request,
			shouldStop: this.shouldStop,
			warnings: [...this.warnings],
			contacts: [...this.contacts],
			signals: [...this.signals],
			scoredContacts: [...this.scoredContacts],
			excludedContacts: [...this.excludedContacts],
			drafts: [...this.drafts],
			approvedDrafts: [...this.approvedDrafts],
			pendingReview: this.pendingReview,
			actionLog: [...this.actionLog],
			followUpQueue: [...this.followUpQueue],
			enrichedContacts: [...this.enrichedContacts],
			report: this.report
		};
	}

	static fromSnapshot(snapshot: GtmContextSnapshot): GtmPipelineContext {
		const ctx = new GtmPipelineContext(snapshot.work, snapshot.request);
		ctx.shouldStop = snapshot.shouldStop;
		ctx.warnings = [...(snapshot.warnings ?? [])];
		ctx.contacts = [...(snapshot.contacts ?? [])];
		ctx.signals = [...(snapshot.signals ?? [])];
		ctx.scoredContacts = [...(snapshot.scoredContacts ?? [])];
		ctx.excludedContacts = [...(snapshot.excludedContacts ?? [])];
		ctx.drafts = [...(snapshot.drafts ?? [])];
		ctx.approvedDrafts = [...(snapshot.approvedDrafts ?? [])];
		ctx.pendingReview = snapshot.pendingReview ?? false;
		ctx.actionLog = [...(snapshot.actionLog ?? [])];
		ctx.followUpQueue = [...(snapshot.followUpQueue ?? [])];
		ctx.enrichedContacts = [...(snapshot.enrichedContacts ?? [])];
		ctx.report = snapshot.report ?? null;
		return ctx;
	}

	/**
	 * Canonical outputs payload. The GTM pipeline produces campaign data,
	 * not directory items, so the item-shaped arrays stay empty and all
	 * stage outputs travel under `extra` keyed by the declared stage keys.
	 */
	toPipelineOutputs(): PipelineOutputs {
		return {
			items: [],
			categories: [],
			tags: [],
			collections: [],
			brands: [],
			extra: {
				contacts: this.contacts,
				signals: this.signals,
				scored_contacts: this.scoredContacts,
				excluded_contacts: this.excludedContacts,
				drafts: this.drafts,
				approved_drafts: this.approvedDrafts,
				pending_review: this.pendingReview,
				action_log: this.actionLog,
				follow_up_queue: this.followUpQueue,
				enriched_contacts: this.enrichedContacts,
				campaign_report: this.report
			}
		};
	}
}
