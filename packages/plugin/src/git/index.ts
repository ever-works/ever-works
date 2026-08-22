export { GitOperations, type GitOperationsConfig } from './git-operations.js';

export type {
	IGitOperations,
	IGitProviderPlugin,
	GitAuth,
	GitCommitter,
	GitRepository,
	GitBranch,
	GitCommit,
	GitFileStatus,
	GitFileChange,
	GitCloneOptions,
	GitCloneBranchOptions,
	GitPushOptions,
	CreateRepoOptions,
	UpdateRepoOptions,
	ForkRepositoryOptions,
	TransferRepoOptions,
	TransferRepoResult,
	CreatePROptions,
	MergeOptions,
	MergeResult,
	GitUser,
	GitOrganization,
	GitPullRequest,
	GitPullRequestAuthor,
	GitRepositoryPermissions,
	GitRepositoryWithPermissions,
	ListRepositoriesOptions,
	GitPullRequestFile,
	ListPullRequestsOptions,
	// PR insights (kanban run cockpit M5/M6).
	GitCheckStatus,
	GitCheckConclusion,
	GitPullRequestCheck,
	GitCiState,
	GitReviewDecision,
	GitPullRequestStatus,
	GitDiffOptions,
	GitDiffFile,
	GitDiffResult
} from '../contracts/capabilities/git-provider.interface.js';

export { isGitProviderPlugin } from '../contracts/capabilities/git-provider.interface.js';

// PR insights (kanban M5/M6) — the pure CI rollup + diff-cap rules every
// git-provider implementation shares.
export {
	DEFAULT_DIFF_MAX_BYTES,
	DEFAULT_DIFF_MAX_FILES,
	HARD_DIFF_MAX_BYTES,
	HARD_DIFF_MAX_FILES,
	MAX_PR_CHECKS,
	deriveCiState,
	resolveDiffCaps,
	capDiffFiles,
	capChecks
} from '../contracts/capabilities/git-provider.pr-insights.js';
