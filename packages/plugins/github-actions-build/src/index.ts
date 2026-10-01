/**
 * `@ever-works/github-actions-build-plugin` — APW-05 T7–T10.
 *
 * The plugin class is the discovery surface; the three directories beside it are
 * the pieces the facade and the jobs call:
 *
 *   - `workflow/` — canonical inputs (`inputs-hash.ts`), the pinned actions
 *     (`action-pins.ts`) and the generator that turns them into the file
 *     (T8, plan §2.4/§4.5);
 *   - `repo/` — branch protection, the workflow writer and the secret sync
 *     (T9/T10, plan §4.6/§4.7);
 *   - the plugin class itself, whose `IBuildPlugin` members throw until the task
 *     that owns each one lands (see its docstring for the exact list).
 */
export {
	GitHubActionsBuildPlugin,
	GitHubActionsBuildPlugin as default,
	notImplemented,
	type GitHubActionsBuildSettings
} from './github-actions-build.plugin.js';
export {
	GITHUB_ACTIONS_BUILD_PLATFORM_MANAGED_KEYS,
	GITHUB_ACTIONS_BUILD_SETTING_DEFAULTS,
	GITHUB_ACTIONS_BUILD_SETTING_KEYS,
	LARGER_RUNNER_LABEL_PATTERN,
	LARGER_RUNNER_MEMORY_MAX_GIB,
	LARGER_RUNNER_MEMORY_MIN_GIB,
	LARGER_RUNNER_VCPU_MAX,
	LARGER_RUNNER_VCPU_MIN,
	PREPARATION_STATE_KEYS,
	gitHubActionsBuildSettingsSchema,
	type GitHubActionsBuildSettingKey,
	type GitHubActionsBuildSettingsSchema,
	type PlatformManagedJsonSchema
} from './settings.schema.js';
export {
	ACTION_PINS,
	ACTION_PIN_SHA_PATTERN,
	actionPin,
	actionPinReference,
	canonicalActionPins,
	GENERATOR_RESERVED_LITERALS,
	type ActionPin,
	type ActionPinKey
} from './workflow/action-pins.js';
export {
	CANONICAL_INPUT_FIELDS,
	canonicalCheck,
	canonicalWorkflowJson,
	canonicaliseWorkflowInputs,
	checkTimeoutMinutes,
	computeWorkflowInputsHash,
	type CanonicalBuildArg,
	type CanonicalBuildBlock,
	type CanonicalBuildService,
	type CanonicalBuildValue,
	type CanonicalCheck,
	type CanonicalRunner,
	type CanonicalSettings,
	type CanonicalWorkflowInputs
} from './workflow/inputs-hash.js';
export {
	branchSlug,
	buildImageRepository,
	canonicalInputsFor,
	fromEnvNames,
	generateWorkflow,
	normaliseBuildBlock,
	secretNamesFor,
	workflowHeader,
	yamlString,
	type WorkflowCheckInput,
	type WorkflowGeneratorInput,
	type WorkflowRepositoryInput,
	type WorkflowRunnerInput,
	type WorkflowSettingsInput
} from './workflow/generator.js';
export { EMBEDDED_VERIFY_RUNNER_SCRIPT } from './workflow/verify-runner.sh.js';
export {
	BRANCH_PROTECTION_RULE_TYPES,
	BRANCH_RULES_MAX_PAGES,
	BRANCH_RULES_PAGE_SIZE,
	isBranchProtected,
	type BranchCoordinates,
	type BranchProtectionDecision,
	type BranchProtectionPayload,
	type BranchProtectionPort,
	type BranchProtectionResponse,
	type BranchProtectionVerdict,
	type BranchRulePayload
} from './repo/branch-protection.js';
export {
	WORKFLOW_COMMIT_MESSAGE_ADD,
	WORKFLOW_COMMIT_MESSAGE_UPDATE,
	WORKFLOW_PULL_REQUEST_BODY,
	WORKFLOW_PULL_REQUEST_TITLE,
	WORKFLOW_READ_BACK_ATTEMPTS,
	WORKFLOW_WRITE_MAX_ATTEMPTS,
	repositoryWriteErrorCode,
	writeWorkflow,
	type WorkflowRepositoryCoordinates,
	type WorkflowWriteInput,
	type WorkflowWriteResult
} from './repo/workflow-writer.js';
export {
	GITHUB_SECRET_NAME_PATTERN,
	buildSecretName,
	createBuildValueSecretSync,
	isSecretLimitError,
	isValidGitHubSecretName,
	loadSodium,
	sealSecretValue,
	type BuildValueSecretSync,
	type BuildValueSyncInput,
	type BuildValueSyncResult,
	type RepositorySecretPort,
	type SecretSyncDependencies,
	type SecretSyncLogger,
	type VerifyPromptedSecretResult
} from './repo/secret-sync.js';
