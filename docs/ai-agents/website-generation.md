---
id: website-generation
title: Website Generation
sidebar_label: Website Generation
sidebar_position: 5
---

# Website Generation

The Website Generation system creates and maintains static websites for each directory by cloning a template repository and syncing branches. It manages the full lifecycle of website repositories, including creation, updates, and template synchronization.

## Architecture Overview

Located in `packages/agent/src/generators/website-generator/`, the system includes:

| Component                 | File                                | Purpose                                         |
| ------------------------- | ----------------------------------- | ----------------------------------------------- |
| `WebsiteGeneratorService` | `website-generator.service.ts`      | Creates website repositories from templates     |
| `WebsiteUpdateService`    | `website-update.service.ts`         | Updates existing websites with template changes |
| `BranchSyncService`       | `branch-sync.service.ts`            | Synchronizes branches from template to target   |
| `WEBSITE_TEMPLATE_CONFIG` | `config/website-template.config.ts` | Template repository configuration               |

## Template Configuration

The website template source is defined in a static config:

```typescript
export const WEBSITE_TEMPLATE_CONFIG = {
	owner: 'ever-works',
	repo: 'ever-works-website-template',
	branch: 'main',
	syncBranches: ['main', 'stage', 'develop']
} as const;
```

This means every generated website is based on the `ever-works-website-template` repository, and three branches (`main`, `stage`, `develop`) are kept in sync.

## Repository Naming Convention

For a directory with slug `my-directory`:

| Repository             | Purpose                                          |
| ---------------------- | ------------------------------------------------ |
| `my-directory-data`    | YAML data repository (items, categories, config) |
| `my-directory`         | Markdown README repository                       |
| `my-directory-website` | Static website repository                        |

## Creation Methods

### Duplicate Method (Default)

The `duplicate` method performs a full copy of the template:

```
1. Cleanup any existing local files
2. Clone the template repository (ever-works-website-template)
3. Create a new repository for the directory's website
4. Replace the Git remote origin with the new repository URL
5. Force push the template content to the new repository
6. Sync all branches from template
```

### Create Using Template Method

The `createUsingTemplate` method uses the Git provider's native template feature:

```typescript
await this.gitFacade.createRepositoryFromTemplate(
	WEBSITE_TEMPLATE_CONFIG.owner,
	WEBSITE_TEMPLATE_CONFIG.repo,
	{
		name: directory.getWebsiteRepo(),
		organization: directory.organization ? directory.getRepoOwner() : undefined,
		isPrivate: true
	},
	{ userId: directoryOwner.id, providerId: directory.gitProvider }
);
```

If the template method fails (not all Git providers support it), the service automatically falls back to the duplicate method.

## Branch Synchronization

The `BranchSyncService` keeps website repositories up to date with the template by syncing all configured branches.

### Sync Strategy

Branch syncing runs sequentially (concurrency = 1) because `cloneOrPull` uses a deterministic directory based on `owner+repo`, meaning parallel syncs would corrupt each other.

```typescript
private readonly MAX_CONCURRENT_SYNCS = 1;
```

### Sync Process Per Branch

For each branch in `WEBSITE_TEMPLATE_CONFIG.syncBranches`:

```
1. Clone the template repository at the specified branch
2. Rename the branch if a mapping is configured (e.g., stage -> main for beta)
3. Replace the remote origin URL to point at the target repository
4. Force push to the target
5. Cleanup temporary files
```

### Branch Mapping (Beta Support)

Directories that opt into beta templates use branch mapping:

```typescript
const branchMapping = directory.websiteTemplateUseBeta
	? { [config.websiteTemplate.getBetaBranch()]: 'main' }
	: undefined;
```

This maps the beta branch (e.g., `stage`) to `main` on the target, so users on the beta channel receive staging template updates as their production content.

### Sync Summary

Each sync operation returns a detailed summary:

```typescript
interface BranchSyncSummary {
	totalBranches: number;
	synced: number;
	skipped: number;
	errors: number;
	results: BranchSyncResult[];
}
```

### Cleanup of Extra Branches

After initial creation via `CREATE_USING_TEMPLATE`, the target repository may have extra branches from the template. The sync service can clean them up:

```typescript
if (cleanupExtraBranches) {
	await this.deleteExtraBranches({ targetOwner, targetRepo, userId, providerId });
}
```

This removes any branches not in the `syncBranches` list.

## Website Updates

The `WebsiteUpdateService` handles updating existing websites when the template changes.

### Update Flow

```
1. Verify the target website repository exists
2. Get the latest commit SHA from the template
3. Try the duplicate update method:
   a. Clone the template at the target branch
   b. Replace remote and force push
4. If duplicate fails, try the template method:
   a. Clone both template and target repositories
   b. Copy all files (excluding .git) from template to target
   c. Commit and push changes
5. Sync all branches from template
```

### Update Check

The service can check if an update is available without applying it:

```typescript
async checkForUpdate(directory: Directory): Promise<{
    updateAvailable: boolean;
    latestCommit?: string;
    currentCommit?: string;
    branch: string;
    error?: string;
}>
```

This compares the template's latest commit SHA against the directory's `websiteTemplateLastCommit` field.

## Update Response DTO

```typescript
interface UpdateWebsiteRepositoryResponseDto {
	status: 'success' | 'error';
	slug: string;
	owner: string;
	repository: string;
	message: string;
	method_used?: string;
}
```

## Auto-Update Support

Directories can enable automatic template updates via the `websiteTemplateAutoUpdate` flag on the directory entity. When enabled, a scheduled task checks for template changes and applies updates automatically. Relevant entity fields:

| Field                          | Type      | Purpose                             |
| ------------------------------ | --------- | ----------------------------------- |
| `websiteTemplateAutoUpdate`    | `boolean` | Enable automatic updates            |
| `websiteTemplateUseBeta`       | `boolean` | Use beta/staging template branch    |
| `websiteTemplateLastCommit`    | `string`  | Last applied template commit SHA    |
| `websiteTemplateLastError`     | `string`  | Last update error message           |
| `websiteTemplateLastUpdatedAt` | `Date`    | Timestamp of last successful update |
| `websiteTemplateLastCheckedAt` | `Date`    | Timestamp of last check             |

## Module Dependencies

```
WebsiteGeneratorModule
  +-- FacadesModule (GitFacadeService for all Git operations)
  providers: [WebsiteGeneratorService, WebsiteUpdateService, BranchSyncService]
```
