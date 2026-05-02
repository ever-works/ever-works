# Website Generator

## Overview

The Website Generator creates and manages the **website repository** for each work - a Next.js application that displays the work content. It duplicates or creates from a template repository, providing users with a deployable website.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  WebsiteGeneratorService                         │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    initialize()                          │    │
│  │                                                          │    │
│  │  1. Check if website repo exists                         │    │
│  │  2. If not: Create using configured method               │    │
│  │     - DUPLICATE: Clone template, force push              │    │
│  │     - CREATE_USING_TEMPLATE: GitHub template feature     │    │
│  │  3. Configure repository settings                        │    │
│  │  4. Return success                                       │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  GitHub Website Repository                       │
│                                                                  │
│  {owner}/{work-slug}-web/                                  │
│  ├── src/                 # Next.js source code                 │
│  ├── public/              # Static assets                       │
│  ├── package.json         # Dependencies                        │
│  ├── next.config.js       # Next.js configuration               │
│  └── .env.example         # Environment template                │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

```
TriggerGenerationOrchestrator
    │
    ├── DataGeneratorService.initialize()
    ├── MarkdownGeneratorService.initialize()
    │
    ▼
WebsiteGeneratorService.initialize(payload)
    │
    ├── Check: Does website repo exist?
    │   │
    │   ├── Yes: Skip creation (already exists)
    │   │
    │   └── No: Create using method
    │       │
    │       ├── DUPLICATE
    │       │   ├── Clone template repo
    │       │   ├── Create target repo
    │       │   ├── Force push template to target
    │       │   └── Done
    │       │
    │       └── CREATE_USING_TEMPLATE
    │           ├── Use GitHub's template feature
    │           ├── Falls back to DUPLICATE if fails
    │           └── Done
    │
    └── Return: {success}
```

## Creation Methods

### DUPLICATE (Recommended)

The most reliable method. Clones the template and pushes to user's account.

```typescript
async duplicateRepository(): Promise<void> {
    // 1. Clone template locally
    await this.gitService.clone(TEMPLATE_REPO_URL, tempDir);

    // 2. Create empty repo in user's account
    await this.githubService.createRepository(targetRepoName, {
        description: `Website for ${work.name}`,
        private: false,
    });

    // 3. Change remote to user's repo
    await this.gitService.setRemote(tempDir, targetRepoUrl);

    // 4. Force push
    await this.gitService.push(tempDir, { force: true });
}
```

**Pros**:

- Works reliably across all GitHub account types
- Full control over the process
- Can handle any template repository

**Cons**:

- Requires local clone (more I/O)
- Slightly slower than template feature

### CREATE_USING_TEMPLATE

Uses GitHub's native template repository feature.

```typescript
async createFromTemplate(): Promise<void> {
    await this.githubService.createRepositoryFromTemplate({
        templateOwner: TEMPLATE_CONFIG.owner,
        templateRepo: TEMPLATE_CONFIG.repo,
        owner: targetOwner,
        name: targetRepoName,
        description: `Website for ${work.name}`,
        private: false,
    });
}
```

**Pros**:

- Faster (no local clone needed)
- Native GitHub feature

**Cons**:

- Requires template repo to be marked as template
- May fail for organization accounts with restrictions
- Falls back to DUPLICATE on failure

## Template Configuration

```typescript
// /packages/agent/src/website-generator/config/website-template.config.ts

export const WEBSITE_TEMPLATE_CONFIG = {
	owner: 'ever-works', // Template owner
	repo: 'website-template', // Template repository name
	branch: 'main' // Branch to use
};
```

## Website Template Structure

The template repository contains a pre-configured Next.js application:

```
website-template/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── page.tsx            # Homepage (work listing)
│   │   ├── [category]/         # Category pages
│   │   └── item/[slug]/        # Item detail pages
│   ├── components/             # React components
│   ├── lib/                    # Utilities
│   └── styles/                 # CSS/Tailwind
├── public/                     # Static assets
├── data/                       # Data fetching (connects to data repo)
├── package.json
├── next.config.js
├── tailwind.config.js
└── .env.example
    DATA_REPO_URL=              # Set to user's data repository
    DIRECTORY_SLUG=             # Work identifier
```

## Website Update Service

For existing websites, the `WebsiteUpdateService` handles template updates:

```typescript
// /packages/agent/src/website-generator/website-update.service.ts

class WebsiteUpdateService {
	async updateFromTemplate(work: Work): Promise<UpdateResult> {
		// 1. Fetch latest template
		// 2. Merge with existing website repo
		// 3. Preserve user customizations
		// 4. Push updates
	}
}
```

### Auto-Update Feature

Works can opt-in to automatic template updates:

```typescript
interface WebsiteAutoUpdateConfig {
	enabled: boolean; // Auto-update enabled
	useBetaVersion: boolean; // Use stage branch instead of main
	lastChecked?: Date;
	lastUpdated?: Date;
	lastError?: string;
}
```

## Interfaces

### WebsiteGeneratorResult

```typescript
interface WebsiteGeneratorResult {
	success: boolean;
	repositoryUrl?: string;
	error?: string;
}
```

### WebsiteRepositoryCreationMethod

```typescript
enum WebsiteRepositoryCreationMethod {
	DUPLICATE = 'DUPLICATE',
	CREATE_USING_TEMPLATE = 'CREATE_USING_TEMPLATE'
}
```

### UpdateWebsiteRepositoryDto

```typescript
class UpdateWebsiteRepositoryDto {
	workId: string;
	autoUpdate?: boolean;
	useBetaVersion?: boolean;
}
```

## Repository Naming Convention

| Repository Type     | Naming Pattern     |
| ------------------- | ------------------ |
| Data Repository     | `{work-slug}-data` |
| Markdown Repository | `{work-slug}`      |
| Website Repository  | `{work-slug}-web`  |

**Example**: For work `awesome-tools`:

- Data: `awesome-tools-data`
- Markdown: `awesome-tools`
- Website: `awesome-tools-web`

## Error Handling

| Error                       | Handling                             |
| --------------------------- | ------------------------------------ |
| Template repo not found     | Log error, fail generation           |
| User lacks permissions      | Report to user, suggest org settings |
| CREATE_USING_TEMPLATE fails | Fallback to DUPLICATE                |
| DUPLICATE fails             | Log error, report to user            |
| Repository already exists   | Skip creation, log info              |

## File Locations

```
/packages/agent/src/website-generator/
├── website-generator.service.ts        # Main service
├── website-update.service.ts           # Template updates
├── config/
│   └── website-template.config.ts      # Template configuration
└── dto/
    └── update-website-repository.dto.ts
```

## Configuration Options

| Option                               | Source                    | Description                        |
| ------------------------------------ | ------------------------- | ---------------------------------- |
| `website_repository_creation_method` | `CreateItemsGeneratorDto` | DUPLICATE or CREATE_USING_TEMPLATE |
| `autoUpdate`                         | Work settings             | Enable auto-updates                |
| `useBetaVersion`                     | Work settings             | Use beta template branch           |

## Integration Points

### Input

- Work metadata (name, slug, description)
- Creation method preference
- Owner/organization info

### Output

- GitHub repository URL
- Success/failure status

### Dependencies

- `GitService`: Git operations
- `GithubService`: GitHub API operations
- Template repository: `ever-works/website-template`

## Deployment Integration

After website repository creation, users can deploy via:

1. **Vercel**: Direct integration through Deploy page
2. **Manual**: Clone and deploy to any host

The `DeployService` (separate from generation) handles Vercel deployment.

## See Also

- [Data Generator Spec](../data-generator/spec.md)
- [Markdown Generator Spec](../markdown-generator/spec.md)
- [Pipeline Overview](../../architecture/pipeline-overview.md)
