import type { User } from '../entities';
import type { InferredProfile } from './schemas';

export class UserResearchCompletedEvent {
	static readonly EVENT_NAME = 'user-research.completed';

	constructor(
		public readonly user: User,
		public readonly profile: InferredProfile,
		public readonly tokensUsed: number,
		public readonly toolCallsCount: number
	) {}
}

export class UserResearchFailedEvent {
	static readonly EVENT_NAME = 'user-research.failed';

	constructor(
		public readonly userId: string,
		public readonly reason: string
	) {}
}

export class WorkProposalAcceptedEvent {
	static readonly EVENT_NAME = 'work-proposal.accepted';

	constructor(
		public readonly userId: string,
		public readonly proposalId: string,
		public readonly workId: string
	) {}
}
