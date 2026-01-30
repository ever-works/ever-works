# Advanced Prompts (Per-Directory Customization)

## Overview

Advanced Prompts allow users to customize AI behavior during directory generation by appending additional instructions to the 7 most impactful pipeline steps. Custom prompts are **appended** to existing prompts, not replacements, ensuring core functionality is preserved while allowing fine-tuning.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Settings Page (Frontend)                      │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  AdvancedPromptsSettings Component                      │    │
│  │                                                         │    │
│  │  ┌─────────────────────────────────────────────────┐   │    │
│  │  │ Relevance Assessment    [textarea]              │   │    │
│  │  │ Item Generation         [textarea]              │   │    │
│  │  │ Item Extraction         [textarea]              │   │    │
│  │  │ Search Query            [textarea]              │   │    │
│  │  │ Categorization          [textarea]              │   │    │
│  │  │ Deduplication           [textarea]              │   │    │
│  │  │ Source Validation       [textarea]              │   │    │
│  │  └─────────────────────────────────────────────────┘   │    │
│  │                                                         │    │
│  │  [Save Prompts]                                        │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (Server Action)
┌─────────────────────────────────────────────────────────────────┐
│                         API Layer                                │
│                                                                  │
│  PUT /directories/:id/advanced-prompts                          │
│  GET /directories/:id/advanced-prompts                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   DirectoryAdvancedPrompts                       │
│                       (Database Entity)                          │
│                                                                  │
│  id: UUID                                                        │
│  directoryId: UUID (one-to-one with Directory)                  │
│  relevanceAssessment: text (nullable)                           │
│  itemGeneration: text (nullable)                                │
│  itemExtraction: text (nullable)                                │
│  searchQuery: text (nullable)                                   │
│  categorization: text (nullable)                                │
│  deduplication: text (nullable)                                 │
│  sourceValidation: text (nullable)                              │
│  createdAt: timestamp                                           │
│  updatedAt: timestamp                                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (During Generation)
┌─────────────────────────────────────────────────────────────────┐
│                    ItemsGeneratorService                         │
│                                                                  │
│  1. Load prompts from DB via repository                         │
│  2. Add to GenerationContext.advancedPrompts                    │
│  3. Each step checks for custom prompt                          │
│  4. appendCustomPrompt(basePrompt, customPrompt)                │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Save Flow

```
Frontend Form
    │
    ▼
updateAdvancedPrompts(directoryId, data)  [Server Action]
    │
    ├── Validate (Zod: max 2000 chars each)
    │
    ▼
directoryAPI.updateAdvancedPrompts(id, data)  [API Client]
    │
    ▼
PUT /directories/:id/advanced-prompts  [Controller]
    │
    ▼
DirectoryAdvancedPromptsService.updateAdvancedPrompts()
    │
    ├── Check user has editor role
    │
    ▼
DirectoryAdvancedPromptsRepository.createOrUpdate()
    │
    ▼
Database (DirectoryAdvancedPrompts table)
```

### Load Flow (During Generation)

```
ItemsGeneratorService.generateItems()
    │
    ▼
DirectoryAdvancedPromptsRepository.findByDirectoryId(directoryId)
    │
    ▼
context.advancedPrompts = {
    relevanceAssessment: "...",
    itemGeneration: "...",
    ...
}
    │
    ▼
PipelineExecutor passes context to each step
    │
    ▼
Each step calls appendCustomPrompt(basePrompt, context.advancedPrompts?.fieldName)
```

## Interfaces

### Entity

```typescript
// /packages/agent/src/entities/directory-advanced-prompts.entity.ts

@Entity({ name: 'directory_advanced_prompts' })
export class DirectoryAdvancedPrompts {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ unique: true })
	directoryId: string;

	@OneToOne(() => Directory, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'directoryId' })
	directory: Directory;

	@Column({ type: 'text', nullable: true })
	relevanceAssessment?: string | null;

	@Column({ type: 'text', nullable: true })
	itemGeneration?: string | null;

	@Column({ type: 'text', nullable: true })
	itemExtraction?: string | null;

	@Column({ type: 'text', nullable: true })
	searchQuery?: string | null;

	@Column({ type: 'text', nullable: true })
	categorization?: string | null;

	@Column({ type: 'text', nullable: true })
	deduplication?: string | null;

	@Column({ type: 'text', nullable: true })
	sourceValidation?: string | null;

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}
```

### DTO

```typescript
// /packages/agent/src/dto/directory-advanced-prompts.dto.ts

export class UpdateDirectoryAdvancedPromptsDto {
	@IsOptional()
	@IsString()
	@MaxLength(2000)
	@Transform(({ value }) => sanitizeString(value))
	relevanceAssessment?: string | null;

	// ... same for all 7 fields
}

export interface DirectoryAdvancedPromptsResponseDto {
	id: string;
	directoryId: string;
	relevanceAssessment?: string | null;
	itemGeneration?: string | null;
	itemExtraction?: string | null;
	searchQuery?: string | null;
	categorization?: string | null;
	deduplication?: string | null;
	sourceValidation?: string | null;
	createdAt: string;
	updatedAt: string;
}
```

### Context Interface

```typescript
// /packages/agent/src/items-generator/interfaces/pipeline.interface.ts

export interface AdvancedPromptsContext {
	relevanceAssessment?: string | null;
	itemGeneration?: string | null;
	itemExtraction?: string | null;
	searchQuery?: string | null;
	categorization?: string | null;
	deduplication?: string | null;
	sourceValidation?: string | null;
}

export interface GenerationContext {
	// ... other fields
	advancedPrompts?: AdvancedPromptsContext | null;
}
```

## Prompt Appending

```typescript
// /packages/agent/src/items-generator/utils/prompt.util.ts

export function appendCustomPrompt(basePrompt: string, customPrompt?: string | null): string {
	if (!customPrompt || customPrompt.trim().length === 0) {
		return basePrompt;
	}
	return `${basePrompt}\n\n## Additional User Instructions:\n${customPrompt.trim()}`;
}
```

**Example Result**:

```
You are an AI assistant that extracts items from web pages...

[Original base prompt content]

## Additional User Instructions:
Only include open-source tools with active GitHub repositories.
Prioritize tools with documentation in English.
```

## Prompt Fields & Pipeline Mapping

| Field                 | Pipeline Step                          | Purpose                                       |
| --------------------- | -------------------------------------- | --------------------------------------------- |
| `relevanceAssessment` | ContentFilteringService (Step 6)       | Customize what content is considered relevant |
| `itemGeneration`      | AiItemGenerationService (Step 4a)      | Customize AI-generated items                  |
| `itemExtraction`      | ItemExtractionService (Step 7)         | Customize how items are extracted from pages  |
| `searchQuery`         | SearchQueryGenerationService (Step 4b) | Customize search query generation             |
| `categorization`      | CategoryProcessingService (Step 9)     | Customize category/tag assignment             |
| `deduplication`       | AiDeduplicator (Step 8)                | Customize duplicate detection rules           |
| `sourceValidation`    | SourceValidationService (Step 10)      | Customize URL validation rules                |

## API Endpoints

### GET /directories/:id/advanced-prompts

Returns the advanced prompts for a directory.

**Response**:

```json
{
    "advancedPrompts": {
        "id": "uuid",
        "directoryId": "uuid",
        "relevanceAssessment": "...",
        "itemGeneration": null,
        ...
    }
}
```

### PUT /directories/:id/advanced-prompts

Updates advanced prompts for a directory.

**Request Body**:

```json
{
    "relevanceAssessment": "Only include open-source tools...",
    "itemGeneration": null,
    ...
}
```

**Authorization**: Requires editor role on directory

## Frontend Component

```typescript
// /apps/web/src/components/directories/detail/settings/AdvancedPromptsSettings.tsx

export function AdvancedPromptsSettings({ directoryId }: Props) {
	// Collapsible section (collapsed by default)
	// 7 textareas with labels and descriptions
	// Save button
	// Loads data when expanded for first time
}
```

## Translations

Located in `apps/web/messages/en.json` under `dashboard.directoryDetail.settings.advancedPrompts`:

- Title: "Advanced Prompts"
- Subtitle: "Customize AI prompts for directory generation..."
- Per-prompt: title, description, placeholder

## File Locations

### Backend

```
/packages/agent/src/
├── entities/
│   └── directory-advanced-prompts.entity.ts
├── database/repositories/
│   └── directory-advanced-prompts.repository.ts
├── dto/
│   └── directory-advanced-prompts.dto.ts
├── services/
│   └── directory-advanced-prompts.service.ts
└── items-generator/
    ├── utils/prompt.util.ts
    └── interfaces/pipeline.interface.ts
```

### API

```
/apps/api/src/directories/
└── directories.controller.ts   # GET/PUT endpoints
```

### Frontend

```
/apps/web/src/
├── lib/api/directory.ts                          # API types & functions
├── app/actions/dashboard/directories.ts          # Server actions
├── components/directories/detail/settings/
│   ├── AdvancedPromptsSettings.tsx              # Main component
│   └── SettingsForm.tsx                          # Parent form
└── messages/en.json                              # Translations
```

## Security Considerations

1. **Sanitization**: Input sanitized via Transform decorator
2. **Length Limit**: Max 2000 characters per prompt
3. **Authorization**: Requires editor role to update
4. **No Prompt Injection**: Custom prompts are clearly labeled section, not replacing base prompts

## Design Decisions

### Why Append Instead of Replace?

1. **Preserves core functionality** - Base prompts contain essential instructions
2. **Security** - Internal prompts not exposed to users
3. **Simplicity** - Users only add what they need
4. **Safety** - Bad custom prompts can't break core behavior

### Why These 7 Prompts?

Selected for maximum impact on content quality:

- Filtering (relevance, source validation)
- Extraction (items, deduplication)
- Generation (AI items, search queries)
- Organization (categorization)

Not included: Domain detection, badge processing, markdown generation (less impactful for customization)
