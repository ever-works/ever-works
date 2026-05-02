---
id: contracts-types
title: Contracts Package Types
sidebar_label: Contracts Package Types
sidebar_position: 10
---

# Contracts Package Types

The `@ever-works/contracts` package defines the shared TypeScript types, interfaces, and enums used across the entire Ever Works platform. It serves as the single source of truth for data shapes that cross package boundaries -- from the API layer to the frontend, from plugins to the generation pipeline. Every package that needs to exchange structured data depends on these contracts.

## Package Overview

| Property         | Value                                            |
| ---------------- | ------------------------------------------------ |
| **Package name** | `@ever-works/contracts`                          |
| **Location**     | `platform/packages/contracts/`                   |
| **Format**       | ESM (TypeScript declarations)                    |
| **Dependents**   | API, frontend, plugins, CLI, generation pipeline |

## Module Exports

```typescript
// Core domain types
export * from './item/item.types.js';
export * from './domain/domain.types.js';
export * from './form/form-field.types.js';

// API contracts
export * from './api/index.js';
```

## Item Types

The `item/item.types.ts` module defines the core data structures for work items -- the primary content entities in the platform.

### Category

```typescript
interface Category {
	name: string;
	slug: string;
	description?: string;
	icon?: string;
	parentSlug?: string;
	itemCount?: number;
}
```

### Tag

```typescript
interface Tag {
	name: string;
	slug: string;
	description?: string;
	itemCount?: number;
}
```

### Collection

```typescript
interface Collection {
	name: string;
	slug: string;
	description?: string;
	items?: string[]; // Item IDs
}
```

### Brand

```typescript
interface Brand {
	name: string;
	slug: string;
	description?: string;
	logo?: string;
	website?: string;
}
```

### Badge and ItemBadges

Badges are visual indicators attached to items for quick recognition.

```typescript
interface Badge {
	label: string;
	color?: string;
	icon?: string;
	tooltip?: string;
}

interface ItemBadges {
	primary?: Badge;
	secondary?: Badge[];
}
```

### ItemData

The central item type used across the platform. Contains all displayable and searchable fields.

```typescript
interface ItemData {
	name: string;
	slug: string;
	description: string;
	url?: string;
	imageUrl?: string;
	categories: Category[];
	tags: Tag[];
	badges?: ItemBadges;
	brand?: Brand;
	metadata?: Record<string, unknown>;
	features?: string[];
	pros?: string[];
	cons?: string[];
	rating?: number;
	reviewCount?: number;
	pricing?: string;
	lastUpdated?: string;
	source?: string;
	sourceUrl?: string;
}
```

### MutableItemData

A subset of `ItemData` fields that can be modified after creation.

```typescript
interface MutableItemData {
	name?: string;
	description?: string;
	url?: string;
	imageUrl?: string;
	categories?: Category[];
	tags?: Tag[];
	badges?: ItemBadges;
	metadata?: Record<string, unknown>;
	features?: string[];
	pros?: string[];
	cons?: string[];
	pricing?: string;
}
```

### Comparison Types

Used for side-by-side item comparisons in the frontend.

```typescript
interface ComparisonDimension {
	name: string;
	key: string;
	type: 'text' | 'number' | 'boolean' | 'rating';
	description?: string;
}

interface ComparisonData {
	dimensions: ComparisonDimension[];
	items: Record<string, Record<string, unknown>>;
}
```

## Domain Types

The `domain/domain.types.ts` module defines types related to domain detection and classification during content generation.

### DomainType

```typescript
enum DomainType {
	SOFTWARE = 'software',
	ECOMMERCE = 'ecommerce',
	SERVICES = 'services',
	GENERAL = 'general'
}
```

The domain type influences how items are structured, what fields are emphasized, and which generation strategies are applied.

### DomainAnalysis

```typescript
interface DomainAnalysis {
	domain: DomainType;
	confidence: number; // 0-1 confidence score
	reasoning: string; // Why this domain was detected
	suggestedFields?: string[];
}
```

### WebPageData

Represents fetched web page content used during content extraction.

```typescript
interface WebPageData {
	url: string;
	title?: string;
	content: string;
	description?: string;
	statusCode?: number;
	contentType?: string;
}
```

### RelevanceAssessment

Scores how relevant a piece of web content is to the user's work topic.

```typescript
interface RelevanceAssessment {
	relevant: boolean;
	score: number; // 0-1 relevance score
	reasoning: string;
	extractableItems?: number;
}
```

## Form Field Types

The `form/form-field.types.ts` module defines the form schema system used for dynamic form rendering in the frontend. This powers plugin settings UIs, work configuration forms, and item editing interfaces.

### FormFieldType

An extensive enumeration of all supported form field types.

```typescript
enum FormFieldType {
	TEXT = 'text',
	TEXTAREA = 'textarea',
	NUMBER = 'number',
	EMAIL = 'email',
	URL = 'url',
	TEL = 'tel',
	PASSWORD = 'password',
	SELECT = 'select',
	MULTI_SELECT = 'multi-select',
	CHECKBOX = 'checkbox',
	RADIO = 'radio',
	TOGGLE = 'toggle',
	DATE = 'date',
	DATETIME = 'datetime',
	TIME = 'time',
	COLOR = 'color',
	FILE = 'file',
	IMAGE = 'image',
	RICH_TEXT = 'rich-text',
	MARKDOWN = 'markdown',
	CODE = 'code',
	JSON = 'json',
	SLIDER = 'slider',
	RATING = 'rating',
	TAGS = 'tags',
	HIDDEN = 'hidden'
}
```

### FormFieldOption

Options for select, multi-select, radio, and checkbox group fields.

```typescript
interface FormFieldOption {
	label: string;
	value: string | number | boolean;
	description?: string;
	disabled?: boolean;
	icon?: string;
}
```

### FormFieldValidation

Validation rules applied to individual form fields.

```typescript
interface FormFieldValidation {
	required?: boolean;
	minLength?: number;
	maxLength?: number;
	min?: number;
	max?: number;
	pattern?: string;
	patternMessage?: string;
	custom?: (value: unknown) => string | undefined;
}
```

### FormFieldCondition

Conditional visibility logic for form fields.

```typescript
interface FormFieldCondition {
	field: string; // Field key to watch
	operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'nin' | 'contains';
	value: unknown;
}
```

### FormFieldDefinition

The complete definition for a single form field.

```typescript
interface FormFieldDefinition {
	key: string;
	type: FormFieldType;
	label: string;
	description?: string;
	placeholder?: string;
	defaultValue?: unknown;
	validation?: FormFieldValidation;
	options?: FormFieldOption[];
	condition?: FormFieldCondition;
	group?: string;
	order?: number;
	disabled?: boolean;
	readOnly?: boolean;
	metadata?: Record<string, unknown>;
}
```

### FormFieldGroup and FormSchema

Groups organize related fields visually, and the schema ties everything together.

```typescript
interface FormFieldGroup {
	key: string;
	label: string;
	description?: string;
	collapsible?: boolean;
	defaultCollapsed?: boolean;
	order?: number;
}

interface FormSchema {
	fields: FormFieldDefinition[];
	groups?: FormFieldGroup[];
	metadata?: Record<string, unknown>;
}
```

## API Contract Types

The `api/` subwork contains types shared between the API and its consumers (frontend, CLI).

### GenerateStatusType

Tracks the state of a work generation process.

```typescript
enum GenerateStatusType {
	IDLE = 'idle',
	PENDING = 'pending',
	RUNNING = 'running',
	COMPLETED = 'completed',
	FAILED = 'failed',
	CANCELLED = 'cancelled'
}
```

### GenerationMethod

How items are generated for a work.

```typescript
enum GenerationMethod {
	AI_GENERATED = 'ai-generated',
	MANUAL = 'manual',
	IMPORTED = 'imported',
	HYBRID = 'hybrid'
}

enum WebsiteRepositoryCreationMethod {
	TEMPLATE = 'template',
	EXISTING = 'existing',
	BLANK = 'blank'
}
```

### Generator DTO Types

Data transfer objects for the generation API.

```typescript
interface CreateItemsGeneratorDto {
	workId: string;
	prompt: string;
	method: GenerationMethod;
	options?: Record<string, unknown>;
}

interface UpdateItemsGeneratorDto {
	prompt?: string;
	options?: Record<string, unknown>;
}
```

### Work Schedule Types

Types for managing automated work update schedules.

```typescript
interface WorkScheduleDto {
	cadence: WorkScheduleAllowedCadence;
	enabled: boolean;
	nextRunAt?: string;
	lastRunAt?: string;
}

interface UpdateWorkSchedulePayload {
	cadence?: WorkScheduleAllowedCadence;
	enabled?: boolean;
}

type WorkScheduleAllowedCadence = 'daily' | 'weekly' | 'biweekly' | 'monthly';
```

## Cross-Package Usage

The contracts package is the foundation that enables type-safe communication across the platform:

| Consumer                | Types Used                                                |
| ----------------------- | --------------------------------------------------------- |
| **API**                 | All types for request/response validation                 |
| **Frontend**            | `ItemData`, `FormSchema`, `Category`, `Tag` for rendering |
| **Plugins**             | `DomainType`, `ItemData`, `WebPageData` for generation    |
| **CLI**                 | `GenerationMethod`, `WorkScheduleDto` for commands        |
| **Generation pipeline** | `DomainAnalysis`, `RelevanceAssessment`, `ComparisonData` |

## File Structure

```
contracts/src/
  index.ts                                    # Root exports
  item/
    item.types.ts                             # Item, Category, Tag, Badge, Comparison types
  domain/
    domain.types.ts                           # DomainType, DomainAnalysis, WebPageData
  form/
    form-field.types.ts                       # FormFieldType, FormSchema, validation types
  api/
    index.ts                                  # API sub-module exports
    generator/
      generation-method.enum.ts              # GenerationMethod, WebsiteRepositoryCreationMethod
      create-items-generator.dto.ts          # Generator DTOs
    work/
      generate-status.enum.ts               # GenerateStatusType
      work-schedule.dto.ts             # Schedule types
```
