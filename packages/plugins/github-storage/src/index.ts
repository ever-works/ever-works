export { GitHubStoragePlugin } from './github-storage.plugin.js';
export { GitHubStoragePlugin as default } from './github-storage.plugin.js';

// LFS helpers (importable by the API for ad-hoc tooling / tests)
export {
	formatPointer,
	parsePointer,
	ensureGitattributes,
	gitattributesLine,
	type LfsPointer
} from './lfs-pointer.js';
export {
	lfsBatch,
	lfsUpload,
	lfsDownload,
	type LfsBatchTarget,
	type LfsObjectIdentifier,
	type LfsBatchOperation,
	type LfsBatchResult,
	type LfsActionDescriptor
} from './lfs-batch.js';
export type { WorkRepoResolver, ResolvedWorkRepo } from './work-repo-resolver.js';
