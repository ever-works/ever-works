# Markdown Generator

## Overview

The Markdown Generator creates and maintains the **markdown repository** for each directory - a GitHub repository containing the README.md and individual item detail pages. It transforms structured item data into human-readable markdown format.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  MarkdownGeneratorService                        │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    initialize()                          │    │
│  │                                                          │    │
│  │  1. Clone/create markdown repository                     │    │
│  │  2. Switch to PR branch (if PR mode)                     │    │
│  │  3. Generate README.md via ReadmeBuilder                 │    │
│  │  4. Generate detail pages for each item                  │    │
│  │  5. Commit and push                                      │    │
│  │  6. Create PR (if PR mode)                               │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Uses: MarkdownRepository, ReadmeBuilder                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  GitHub Markdown Repository                      │
│                                                                  │
│  {owner}/{directory-slug}/                                      │
│  ├── README.md            # Main directory listing              │
│  ├── details/             # Individual item pages               │
│  │   ├── item-slug-1.md                                         │
│  │   ├── item-slug-2.md                                         │
│  │   └── ...                                                    │
│  └── LICENSE              # Auto-generated license              │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

```
TriggerGenerationOrchestrator
    │
    ├── DataGeneratorService.initialize()
    │   └── Returns: {items, categories, tags, ...}
    │
    ▼
MarkdownGeneratorService.initialize(payload, dataResult)
    │
    ├── Clone/create repository
    │
    ├── Switch to PR branch (if update_with_pull_request)
    │
    ├── ReadmeBuilder.build()
    │   ├── Generate header (custom or default)
    │   ├── Generate table of contents
    │   ├── Generate category sections
    │   │   └── For each item: name, description, link, badges
    │   ├── Generate footer (custom or default)
    │   └── Returns: README.md content
    │
    ├── Write README.md
    │
    ├── For each item:
    │   └── Write details/{slug}.md
    │
    ├── Commit & Push
    │
    └── Create PR (if PR mode)
        │
        ▼
    Returns: {success, prUpdate?}
```

## Repository Structure

### README.md

```markdown
# My Directory

A curated list of the best monitoring tools.

## Table of Contents

- [Monitoring](#monitoring)
- [Logging](#logging)
- [Alerting](#alerting)

## Monitoring

| Name                                | Description                   |
| ----------------------------------- | ----------------------------- |
| [Prometheus](details/prometheus.md) | Open-source monitoring system |
| [Grafana](details/grafana.md)       | Visualization and analytics   |

## Logging

| Name                                      | Description               |
| ----------------------------------------- | ------------------------- |
| [Elasticsearch](details/elasticsearch.md) | Distributed search engine |

---

## Contributing

[Contributing guidelines]

## License

[License text]
```

### details/{slug}.md

```markdown
# Prometheus

Open-source systems monitoring and alerting toolkit.

## Overview

Prometheus is an open-source monitoring system with a dimensional data model...

## Features

- Multi-dimensional data model
- Flexible query language (PromQL)
- Pull-based metrics collection
- Service discovery

## Links

- [Official Website](https://prometheus.io)
- [GitHub Repository](https://github.com/prometheus/prometheus)
- [Documentation](https://prometheus.io/docs)

## Tags

`open-source` `monitoring` `cloud-native`

---

_Last updated: 2024-01-16_
```

## Key Components

### MarkdownGeneratorService

Main orchestrator for markdown generation.

```typescript
class MarkdownGeneratorService {
	async initialize(
		payload: DirectoryGenerationPayload,
		dataResult: DataGeneratorResult
	): Promise<MarkdownGeneratorResult>;
}
```

### MarkdownRepository

Handles file operations for the markdown repository.

```typescript
class MarkdownRepository {
	// README operations
	writeReadme(content: string): Promise<void>;
	readReadme(): Promise<string | null>;

	// Detail page operations
	writeDetails(slug: string, content: string): Promise<void>;
	readDetails(slug: string): Promise<string | null>;
	removeDetails(slug: string): Promise<void>;
	listDetails(): Promise<string[]>;

	// Cleanup
	resetFiles(): Promise<void>; // Clear generated files, keep .git

	// Git operations
	clone(): Promise<void>;
	commit(message: string): Promise<void>;
	push(): Promise<void>;
	createBranch(name: string): Promise<void>;
	createPullRequest(title: string, body: string): Promise<PR>;
}
```

### ReadmeBuilder

Generates README.md content from structured data.

```typescript
class ReadmeBuilder {
	build(options: ReadmeBuildOptions): string;
}

interface ReadmeBuildOptions {
	directory: Directory;
	items: ItemData[];
	categories: Category[];
	tags: Tag[];
	readmeConfig?: ReadmeConfig;
}

interface ReadmeConfig {
	header?: string;
	overwriteDefaultHeader?: boolean;
	footer?: string;
	overwriteDefaultFooter?: boolean;
}
```

## README Generation

### Header Section

**Default Header**:

```markdown
# {Directory Name}

{Directory Description}
```

**Custom Header** (if `readmeConfig.header` provided):

- If `overwriteDefaultHeader: true`: Uses only custom header
- If `overwriteDefaultHeader: false`: Prepends custom header to default

### Table of Contents

Generated from categories with priority ordering:

```markdown
## Table of Contents

- [Priority Category 1](#priority-category-1)
- [Priority Category 2](#priority-category-2)
- [Other Category](#other-category)
```

### Category Sections

Each category gets a section with a table:

```markdown
## Monitoring

| Name                        | Description    |
| --------------------------- | -------------- |
| [Tool 1](details/tool-1.md) | Description... |
| [Tool 2](details/tool-2.md) | Description... |
```

**Featured Items**: Marked with star or badge

**Item Ordering**:

1. Featured items first
2. By `order` field (if set)
3. Alphabetically by name

### Footer Section

**Default Footer**:

```markdown
---

## Contributing

Contributions welcome! Please read our contributing guidelines.

## License

This list is licensed under [LICENSE].

---

_Generated with [Ever Works](https://ever.works)_
```

**Custom Footer**: Same logic as header

## Detail Page Generation

Each item gets a detail page at `details/{slug}.md`:

```typescript
function generateDetailPage(item: ItemData): string {
	return `
# ${item.name}

${item.description}

## Overview

${item.markdown || 'No detailed description available.'}

## Links

- [Official Website](${item.source_url})

## Tags

${item.tags.map((t) => `\`${t}\``).join(' ')}

---

*Last updated: ${new Date().toISOString().split('T')[0]}*
    `.trim();
}
```

## Interfaces

### MarkdownGeneratorResult

```typescript
interface MarkdownGeneratorResult {
	success: boolean;
	prUpdate?: {
		branch: string;
		title: string;
		body: string;
		number: number;
		url: string;
	};
	error?: string;
}
```

### ReadmeConfig

```typescript
interface ReadmeConfig {
	header?: string; // Custom header content
	overwriteDefaultHeader?: boolean; // Replace vs prepend
	footer?: string; // Custom footer content
	overwriteDefaultFooter?: boolean; // Replace vs append
}
```

## PR Mode

When `update_with_pull_request: true`:

1. Create branch: `ever-update-{timestamp}`
2. Make all changes on branch
3. Create PR with summary:

```markdown
## README Update

This PR updates the directory README with the latest items.

### Changes

- Added 5 new items
- Updated 3 existing items
- Removed 1 outdated item

### Categories

- Monitoring: 12 items
- Logging: 8 items
- Alerting: 5 items

---

_Generated by Ever Works_
```

## Repository Initialization

For new directories, the service:

1. Creates GitHub repository
2. Initializes with basic structure
3. Adds LICENSE file
4. Commits initial README

```typescript
async initializeRepository(): Promise<void> {
    await this.githubService.createRepository(repoName, {
        description: directory.description,
        private: false,
        auto_init: true,
    });

    await this.markdownRepository.writeReadme(initialReadme);
    await this.markdownRepository.commit('Initial commit');
    await this.markdownRepository.push();
}
```

## Error Handling

| Error                    | Handling                             |
| ------------------------ | ------------------------------------ |
| Repository doesn't exist | Create it                            |
| Clone fails              | Retry with backoff                   |
| Write fails              | Log error, continue with other files |
| Push fails               | Check permissions, retry             |
| PR creation fails        | Fall back to direct commit           |

## File Locations

```
/packages/agent/src/markdown-generator/
├── markdown-generator.service.ts   # Main service
├── markdown-repository.ts          # File operations
├── readme-builder.ts               # README generation
└── templates/                      # Optional templates
```

## Configuration

Configuration comes from:

1. `CreateItemsGeneratorDto.update_with_pull_request`
2. `Directory.readmeConfig` (header/footer customization)

## Integration Points

- **Input**: Items, categories, tags from DataGenerator
- **Output**: GitHub markdown repository
- **Dependencies**: GitService for GitHub operations

## See Also

- [Data Generator Spec](../data-generator/spec.md)
- [Website Generator Spec](../website-generator/spec.md)
- [Pipeline Overview](../../architecture/pipeline-overview.md)
