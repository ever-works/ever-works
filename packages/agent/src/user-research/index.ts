export * from './schemas';
export * from './events';
export * from './prompts';
export * from './limits';
export * from './user-research.service';
export * from './work-proposal.service';
export * from './work-proposal.repository';
export * from './user-research.module';
// Phase 1 PR FF — transient classifier + backoff helper, callable
// from the (future) goal-execution path that decides whether to
// auto-retry a failed Idea build.
export * from './idea-failure-classifier';
export {
    WorkProposal,
    WorkProposalStatus,
    WorkProposalSource,
    IdeaFailureKind,
    type WorkProposalCategory,
    type WorkProposalField,
    type WorkProposalFieldType,
    type WorkProposalRecommendedPlugin,
} from '../entities/work-proposal.entity';
export { type InferredUserProfile } from '../entities/user.entity';
