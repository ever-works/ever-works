/**
 * EW-638 — Single source of truth for the entity class NAMES exposed by the
 * `@ever-works/agent` entities barrel (`../entities`).
 *
 * Why a string-only list, separate from the real class registry:
 *
 *   `database.config.spec.ts` mocks the entire `../entities` barrel with
 *   stub classes — loading the real barrel under Jest triggers a known
 *   `path-scurry` init bug via TypeORM's CJS init path. The mock has to be
 *   declared inside `jest.mock(...)`'s factory and CAN'T import real entity
 *   classes (would re-trigger the bug).
 *
 *   So the spec needs an entity-name list that:
 *     - loads under Jest without dragging in TypeORM, and
 *     - stays in sync with the real entities barrel.
 *
 *   This file is that list. It exports a plain string array — nothing else.
 *   The spec uses `jest.requireActual('./_entity-names')` to read it inside
 *   the `jest.mock` factory, then synthesizes `{ Name: class Name {} }` from
 *   each entry.
 *
 *   Drift between THIS list and the real `../entities` barrel is detected
 *   by a dedicated spec in `database.module.spec.ts` (which already loads
 *   the real barrel, so the path-scurry constraint doesn't apply there).
 *
 * # When adding a new entity
 *
 *   1. Add its `export * from './<file>.entity'` to `../entities/index.ts`.
 *   2. Add its name (string) below — alphabetical insertion.
 *   3. If it should be registered with TypeORM's `forFeature(ENTITIES)`,
 *      also add the class to `database.config.ts`'s `ENTITIES` array.
 *
 *   The drift spec in `database.module.spec.ts` will fail loudly if you
 *   miss step 2 or 3.
 *
 * Excluded from this list:
 *   - `CacheEntry` (mocked under `../entities/cache.entity`, separate barrel)
 *   - Plugin entities (mocked under `../plugins/entities`)
 *   - Account-transfer entities (mocked under `../account-transfer/entities`)
 *
 *   Those barrels have their own jest.mock blocks in `database.config.spec.ts`
 *   and don't share this inventory.
 */

export const AGENT_ENTITY_NAMES: ReadonlyArray<string> = [
    'ActivityLog',
    'ApiKey',
    'AuthAccount',
    'AuthSession',
    'AuthVerification',
    'CacheEntry',
    'Conversation',
    'ConversationMessage',
    'GitHubAppInstallation',
    'GitHubAppInstallationRepository',
    'GitHubAppUserLink',
    'Mission',
    'Notification',
    'OnboardingRequest',
    'PluginUsageEvent',
    'RefreshToken',
    'SubscriptionPlan',
    'Template',
    'TemplateCustomization',
    'UsageLedgerEntry',
    'User',
    'UserSubscription',
    'UserTemplatePreference',
    'WebhookDelivery',
    'WebhookSubscription',
    'Work',
    'WorkAdvancedPrompts',
    'WorkAgentGoal',
    'WorkAgentPreference',
    'WorkAgentRun',
    'WorkAgentRunLog',
    'WorkBudget',
    'WorkBudgetAlertState',
    'WorkCustomDomain',
    'WorkDeployment',
    'WorkGenerationHistory',
    'WorkInvitation',
    'WorkKnowledgeChunk',
    'WorkKnowledgeCitation',
    'WorkKnowledgeDocument',
    'WorkKnowledgeTag',
    'WorkKnowledgeUpload',
    'WorkMember',
    'WorkProposal',
    'WorkSchedule',
] as const;
