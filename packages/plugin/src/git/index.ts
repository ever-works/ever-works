export {
	GitOperations,
	RepositoryNotReadyError,
	checkoutDirectoryName,
	CHECKOUT_DIR_PREFIX,
	CHECKOUT_DIR_SLUG_MAX_LENGTH,
	CHECKOUT_DIR_NAME_MAX_LENGTH,
	type GitOperationsConfig
} from './git-operations.js';

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
	GitDiffResult,
	// Release promotion lane (self-build slice AI) — one named workflow's
	// verdict for one commit.
	GitWorkflowRun,
	// Upstream pull requests (APW-09 T2) — the two review reads and the
	// temporary interaction limit, with their element types.
	GitPullRequestReviewState,
	GitPullRequestReview,
	GitPullRequestReviewComment,
	GitInteractionLimit
} from '../contracts/capabilities/git-provider.interface.js';

export { isGitProviderPlugin } from '../contracts/capabilities/git-provider.interface.js';

// App Works fork lifecycle (APW-02 T9/T10) — the typed surface of the optional
// `findExistingFork` / `syncForkBranch` / `getForkDivergence` /
// `createRepositoryCopy` / `setActionsPermissions` / `createWebhook` /
// `deleteWebhook` / `createBranchFromSha` / `updateBranchRef` members, plus the
// `GitProviderRequestError` those methods throw.
export type {
	GitProviderErrorReason,
	GitProviderErrorDetails,
	GitForkSyncResult,
	GitForkDivergence,
	GitRepositoryCopyInput,
	GitRepositoryCopyResult,
	GitWorkflowRef,
	GitActionsPermissionsInput,
	GitActionsPermissionsResult,
	GitWebhookInput
} from '../contracts/capabilities/git-provider.app-forks.js';

export { GitProviderRequestError } from '../contracts/capabilities/git-provider.app-forks.js';

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
