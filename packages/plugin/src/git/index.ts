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
	GitPushOptions,
	CreateRepoOptions,
	UpdateRepoOptions,
	ForkRepositoryOptions,
	CreatePROptions,
	MergeOptions,
	MergeResult,
	GitUser,
	GitOrganization,
	GitPullRequest,
	GitRepositoryPermissions,
	GitRepositoryWithPermissions,
	ListRepositoriesOptions,
	GitPullRequestFile,
	ListPullRequestsOptions
} from '../contracts/capabilities/git-provider.interface.js';

export { isGitProviderPlugin } from '../contracts/capabilities/git-provider.interface.js';
