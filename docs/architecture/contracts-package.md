---
id: contracts-package
title: Contracts Package Reference
sidebar_label: Contracts Package
sidebar_position: 6
---

# Contracts Package Reference

The `@ever-works/contracts` package provides shared TypeScript type definitions used across the entire Ever Works monorepo. It defines the canonical data structures for items, domains, forms, and API DTOs, ensuring type consistency between the backend, frontend, and plugin packages.

## Package Overview

| Property          | Value                        |
| ----------------- | ---------------------------- |
| **Package name**  | `@ever-works/contracts`      |
| **License**       | AGPL-3.0                          |
| **Module format** | Dual ESM/CJS (via tsup)      |
| **Build tool**    | tsup                         |
| **Dependencies**  | None (pure type definitions) |

## Export Map

The package exposes four entry points:

| Import Path                    | Source         | Content                                                             |
| ------------------------------ | -------------- | ------------------------------------------------------------------- |
| `@ever-works/contracts`        | `src/index.ts` | All item, domain, and form types (re-export)                        |
| `@ever-works/contracts/item`   | `src/item/`    | Item data structures, categories, tags, collections, brands, badges |
| `@ever-works/contracts/domain` | `src/domain/`  | Domain analysis types, web page data, relevance assessment          |
| `@ever-works/contracts/form`   | `src/form/`    | Form field definitions, validation rules, field groups              |
| `@ever-works/contracts/api`    | `src/api/`     | API request/response DTOs for generators and works                  |

## Item Types (`@ever-works/contracts/item`)

### Core Interfaces

#### Identifiable

The base identity interface used across the platform:

```typescript
interface Identifiable {
	readonly id: string;
	readonly name: string;
}
```

#### ItemData

The central data structure representing a work entry:

```typescript
interface ItemData {
	readonly name: string;
	readonly description: string;
	readonly featured?: boolean;
	readonly order?: number;
	readonly source_url: string;
	readonly category: string | readonly string[];
	readonly slug?: string;
	readonly tags: readonly string[] | readonly Tag[];
	readonly collection?: string;
	readonly markdown?: string;
	readonly badges?: ItemBadges;
	readonly brand?: string | Brand;
	readonly brand_logo_url?: string | null;
	readonly images?: readonly string[];
}
```

A mutable counterpart `MutableItemData` is available for processing pipelines where items are built incrementally.

#### Category

```typescript
interface Category {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly icon_url?: string;
	readonly priority?: number; // Lower = higher priority
}
```

#### Tag

```typescript
interface Tag {
	readonly id: string;
	readonly name: string;
}
```

#### Collection

```typescript
interface Collection {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly icon_url?: string;
	readonly priority?: number;
}
```

#### Brand

```typescript
interface Brand {
	readonly id: string;
	readonly name: string;
	readonly logo_url?: string;
	readonly website?: string;
}
```

### Badge System

Badges represent evaluated attributes of items (e.g., "Open Source", "Free Tier", "Enterprise Ready"):

```typescript
interface Badge {
	readonly value: string;
	readonly evaluated_at?: string;
	readonly details?: string | null;
	readonly type?: string; // Legacy field
}

type ItemBadges = Record<string, Badge>;

interface BadgeEvaluationResult {
	readonly badges: ItemBadges;
	readonly evaluation_summary: string;
	readonly evaluated_at: string;
	readonly domain_type?: string;
}
```

### Comparison Types

Types for A-vs-B comparison pages:

```typescript
interface ComparisonDimension {
	readonly name: string;
	readonly item_a_summary: string;
	readonly item_b_summary: string;
	readonly item_a_score?: number;
	readonly item_b_score?: number;
	readonly winner?: 'item_a' | 'item_b' | 'tie';
}

interface ComparisonData {
	readonly id: string;
	readonly slug: string;
	readonly title: string;
	readonly item_a_slug: string;
	readonly item_b_slug: string;
	readonly item_a_name: string;
	readonly item_b_name: string;
	readonly category: string;
	readonly summary: string;
	readonly verdict: string;
	readonly verdict_winner?: 'item_a' | 'item_b' | 'tie';
	readonly dimensions: readonly ComparisonDimension[];
	readonly sources: readonly string[];
	readonly generated_at: string;
}
```

## Domain Types (`@ever-works/contracts/domain`)

### DomainType Enum

Classifies work content for domain-specific behavior:

```typescript
enum DomainType {
	SOFTWARE = 'software',
	ECOMMERCE = 'ecommerce',
	SERVICES = 'services',
	GENERAL = 'general'
}
```

### DomainAnalysis

Result of AI-powered domain analysis:

```typescript
interface DomainAnalysis {
	readonly domain_type: DomainType;
	readonly confidence: number; // 0.0 to 1.0
	readonly item_noun?: string; // e.g., "tool", "product"
	readonly expected_attributes?: readonly string[];
	readonly official_source_patterns?: readonly string[];
	readonly aggregator_domains?: readonly string[];
}
```

### WebPageData

Represents content extracted from a web page:

```typescript
interface WebPageData {
	readonly source_url: string;
	readonly retrieved_at: string; // ISO date string
	readonly raw_content: string;
}
```

### RelevanceAssessment

Result of content relevance evaluation:

```typescript
interface RelevanceAssessment {
	readonly relevant: boolean;
	readonly relevance_score: number; // 0.0 to 1.0
	readonly reason: string;
}
```

## Form Types (`@ever-works/contracts/form`)

### FormFieldType

Supported form field types:

| Type                     | Description                        |
| ------------------------ | ---------------------------------- |
| `text`                   | Single-line text input             |
| `textarea`               | Multi-line text input              |
| `number`                 | Numeric input                      |
| `boolean`                | Toggle/checkbox                    |
| `select`                 | Single-selection dropdown          |
| `multiselect`            | Multi-selection dropdown           |
| `date` / `datetime`      | Date or datetime picker            |
| `url` / `email`          | URL or email input with validation |
| `password`               | Password input                     |
| `file` / `image`         | File or image upload               |
| `color`                  | Color picker                       |
| `json` / `code`          | JSON or code editor                |
| `markdown` / `rich-text` | Markdown or rich text editor       |
| `tags`                   | Tag input                          |
| `rating` / `range`       | Rating stars or range slider       |
| `hidden`                 | Hidden field                       |

### FormFieldDefinition

Complete field definition with validation and conditional logic:

```typescript
interface FormFieldDefinition {
	readonly name: string;
	readonly type: FormFieldType;
	readonly label: string;
	readonly description?: string;
	readonly placeholder?: string;
	readonly defaultValue?: unknown;
	readonly options?: readonly FormFieldOption[];
	readonly validation?: FormFieldValidation;
	readonly showIf?: FormFieldCondition | readonly FormFieldCondition[];
	readonly requiredIf?: FormFieldCondition | readonly FormFieldCondition[];
	readonly disabled?: boolean;
	readonly readOnly?: boolean;
	readonly group?: string;
	readonly order?: number;
	readonly config?: Record<string, unknown>;
}
```

### FormFieldValidation

```typescript
interface FormFieldValidation {
	readonly required?: boolean;
	readonly min?: number;
	readonly max?: number;
	readonly pattern?: string;
	readonly message?: string;
}
```

### FormFieldCondition

Conditional visibility and requirements:

```typescript
interface FormFieldCondition {
	readonly field: string;
	readonly operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'not_contains';
	readonly value: unknown;
}
```

## API Types (`@ever-works/contracts/api`)

### Generator API Types

| Type                              | Description                                    |
| --------------------------------- | ---------------------------------------------- |
| `GenerationMethod`                | Enum: generation method (e.g., `RECREATE`)     |
| `WebsiteRepositoryCreationMethod` | Enum: website repo creation method             |
| `ProvidersDto`                    | Provider configuration for generation requests |
| `CreateItemsGeneratorDto`         | DTO for creating a generator                   |
| `SubmitItemDto`                   | DTO for submitting a new item                  |
| `RemoveItemDto`                   | DTO for removing an item                       |
| `UpdateItemDto`                   | DTO for updating an item                       |
| `ExtractItemDetailsDto`           | DTO for extracting item details                |

### Work API Types

| Type                            | Description                                                |
| ------------------------------- | ---------------------------------------------------------- |
| `GenerateStatusType`            | Enum: generation status (idle, running, completed, failed) |
| `WorkScheduleCadence`           | Enum: schedule frequency (daily, weekly, monthly)          |
| `WorkScheduleStatus`            | Enum: schedule status (active, paused, disabled)           |
| `WorkScheduleBillingMode`       | Enum: billing mode for scheduled generations               |
| `WorkScheduleDto`               | DTO for work schedule configuration                        |
| `GenerationMetrics`             | Metrics from a generation run                              |
| `WorkGenerationHistoryEntry`    | Single generation history entry                            |
| `WorkGenerationHistoryResponse` | Paginated generation history                               |

## Usage Across the Monorepo

The contracts package is consumed by every major package:

| Consumer             | Import Pattern              | Purpose                                                   |
| -------------------- | --------------------------- | --------------------------------------------------------- |
| `@ever-works/agent`  | `@ever-works/contracts`     | Core item, domain, and form types in generators, services |
| `@ever-works/plugin` | `@ever-works/contracts`     | Item types in event payloads and pipeline outputs         |
| `apps/api`           | `@ever-works/contracts/api` | API DTOs for request validation and response typing       |
| `apps/web`           | `@ever-works/contracts`     | TypeScript types for API responses in the frontend        |
| Plugin packages      | `@ever-works/contracts`     | Item types for plugin processing                          |

## Build

```bash
# Build the contracts package
cd packages/contracts && pnpm build

# Watch mode for development
cd packages/contracts && pnpm dev

# Type checking
cd packages/contracts && pnpm type-check
```

The package builds with tsup, producing ESM (`.js`) and CJS (`.cjs`) outputs along with TypeScript declaration files (`.d.ts`). Since it contains only types and interfaces with no runtime dependencies, the build output is minimal.
