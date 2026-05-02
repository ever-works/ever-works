---
id: generation-ui
title: Generation Workflow UI
sidebar_label: Generation Workflow UI
sidebar_position: 12
---

# Generation Workflow UI

The generation interface allows users to create or update work items using AI. It consists of a server page that determines the current state, a multi-section form for configuring generation parameters, provider selectors, dynamic plugin fields, and a progress display for active generation runs.

## Architecture Overview

```
Generator Page (server)
  |-- checks work permissions via canGenerate()
  |-- checks generateStatus to determine view
  |
  |-- GenerationProgress (if GENERATING)
  |     |-- animated progress bar
  |     |-- step text and item count
  |
  |-- GeneratorForm (otherwise)
        |-- RequiredFields (name, prompt)
        |-- UpdateItemsFields (for existing works)
        |-- ProviderSelectionSection
        |-- DynamicPluginFields
```

## Generator Page

**Route**: `/works/[id]/generator`
**File**: `src/app/[locale]/(dashboard)/works/[id]/generator/page.tsx`

The server component fetches work data and configuration in parallel, then determines which view to render.

```typescript
const [workRes, configRes] = await Promise.all([
	workAPI.get(id),
	workAPI.getConfig(id).catch(() => ({ config: undefined }))
]);
```

**View Selection**:

| Condition                                  | View                 |
| ------------------------------------------ | -------------------- |
| `canGenerate(work.userRole)` is false | `notFound()` (404)   |
| `generateStatus.status === GENERATING`     | `GenerationProgress` |
| Otherwise                                  | `GeneratorForm`      |

The `canGenerate` function performs a server-side role check, ensuring only editors and above can access the generator.

## GeneratorForm

**File**: `src/components/works/detail/generator/GeneratorForm.tsx`

The main form component that handles both new work generation and updates to existing works.

**Props**:

| Prop          | Type               | Description                                                    |
| ------------- | ------------------ | -------------------------------------------------------------- |
| `workId` | `string`           | Work identifier                                           |
| `work`   | `Work`        | Full work object                                          |
| `config`      | `WorkConfig?` | Work configuration (may be undefined for new works) |

### Form State

The form manages three layers of state:

| State          | Type                       | Description                                                         |
| -------------- | -------------------------- | ------------------------------------------------------------------- |
| `coreData`     | Object                     | Name, prompt, generation method, PR toggle, website creation method |
| `pluginConfig` | `Record<string, unknown>`  | Dynamic key-value pairs from pipeline plugin fields                 |
| `providers`    | Via `useProviderSelection` | Selected providers for each category (AI, search, screenshot, etc.) |

**Core Data Fields**:

```typescript
{
    name: string;                                  // Work name (from work.name)
    prompt: string;                                // Generation prompt
    generation_method?: GenerationMethod;           // CREATE_UPDATE or RECREATE
    update_with_pull_request?: boolean;             // Whether to create PRs for changes
    website_repository_creation_method?: WebsiteRepositoryCreationMethod;
}
```

### Form Schema Loading

The form dynamically loads its schema from the backend based on the selected pipeline provider.

```typescript
useEffect(() => {
	const pipelineId = providers.pipeline || undefined;
	if (pipelineId === lastFetchedPipelineRef.current && formSchema) return;

	async function loadFormSchema() {
		const result = await getFormSchema(workId, pipelineId);
		if (result.success && result.data) {
			setFormSchema(result.data);
			syncResolvedPipeline(result.data);
		}
	}
	loadFormSchema();
}, [workId, providers.pipeline, syncResolvedPipeline]);
```

**Stale Response Protection**: A `fetchVersionRef` counter ensures that responses from outdated requests (due to rapid pipeline changes) are discarded.

**Seed Data**: The previous generation's `pluginConfig` is stored in a ref and used to populate defaults when the pipeline matches the last run.

### View Modes

| Context                                 | Fields Shown                                                    |
| --------------------------------------- | --------------------------------------------------------------- |
| New work (never generated)         | RequiredFields + ProviderSelectionSection + DynamicPluginFields |
| Existing work (simple update)      | UpdateItemsFields only                                          |
| Existing work (advanced toggle on) | UpdateItemsFields + RequiredFields + providers + plugin fields  |

The advanced options toggle lets users of existing works access the full generation form without being overwhelmed by options for a simple update.

### Submission Flow

The form handles two distinct submission paths:

**Simple Update** (existing work, no advanced options):

```typescript
const updateData: UpdateItemsGeneratorDto = {
	generation_method: coreData.generation_method,
	update_with_pull_request: coreData.update_with_pull_request
};
result = await updateItems(workId, updateData);
```

**Full Generation** (new work or advanced mode):

```typescript
const generateData: CreateItemsGeneratorDto = {
	name: coreData.name,
	prompt: coreData.prompt,
	generation_method: coreData.generation_method,
	update_with_pull_request: coreData.update_with_pull_request,
	website_repository_creation_method: coreData.website_repository_creation_method,
	providers: buildSelectedProviders(formSchema),
	pluginConfig: Object.keys(pluginConfig).length > 0 ? pluginConfig : undefined
};
result = await generateItems(workId, generateData);
```

**Recreate Confirmation**: When the generation method is `RECREATE` and the work has existing data, a confirmation dialog warns that all items will be deleted and regenerated. The dialog uses the `Dialog` component with a danger-styled confirm button.

**Unconfigured Provider Check**: Before full generation, `getUnconfiguredProviders(formSchema)` checks that all required providers are configured and shows a toast error if any are missing.

## RequiredFields

**File**: `src/components/works/detail/generator/RequiredFields.tsx`

Renders the core generation inputs.

| Field             | Component          | Description                                           |
| ----------------- | ------------------ | ----------------------------------------------------- |
| Work Name    | `Input` (disabled) | Read-only, pre-filled from work data             |
| Generation Prompt | `Textarea`         | Multi-line prompt for AI generation, with helper text |

## UpdateItemsFields

**File**: `src/components/works/detail/generator/UpdateItemsFields.tsx`

Renders update-specific controls for existing works.

| Field             | Component      | Description                                          |
| ----------------- | -------------- | ---------------------------------------------------- |
| Generation Method | `Select`       | Dropdown with `CREATE_UPDATE` and `RECREATE` options |
| Update with PR    | `Switch`       | Toggle for creating pull requests for changes        |
| PR Update Info    | `PrUpdateInfo` | Shows status of the last main and data PRs           |

When `RECREATE` is selected and the work has existing configuration, an inline warning banner appears.

## ProviderSelector

**File**: `src/components/works/detail/generator/ProviderSelector.tsx`

Renders a horizontal row of provider buttons for a single category (AI, search, screenshot, etc.).

**Props**:

| Prop        | Type               | Description                                       |
| ----------- | ------------------ | ------------------------------------------------- | ----------------------------------------------------- |
| `label`     | `string`           | Category label (displayed in a 128px-wide column) |
| `providers` | `ProviderOption[]` | Available providers for this category             |
| `value`     | `string            | null`                                             | Currently selected provider ID (`null` = use default) |
| `onChange`  | `(id: string       | null) => void`                                    | Selection handler                                     |

**Default Resolution**: Uses `resolveEffectiveDefault()` from `@ever-works/plugin` to determine which provider is the effective default when no explicit selection has been made. The default provider cannot be deselected.

**Unconfigured Providers**: Shown with reduced opacity and a tooltip explaining the configuration requirement. They cannot be selected.

### PipelineModeSelector

Also defined in the same file, this component renders pipeline options as radio buttons instead of toggle buttons. Each pipeline shows its name and optional description.

## DynamicPluginFields

**File**: `src/components/works/detail/generator/DynamicPluginFields.tsx`

Renders form fields that are dynamically defined by the active pipeline plugin.

**Props**:

| Prop       | Type                                        | Description                                            |
| ---------- | ------------------------------------------- | ------------------------------------------------------ |
| `fields`   | `FormFieldDefinition[]`                     | Field definitions from the form schema                 |
| `groups`   | `FormFieldGroup[]?`                         | Optional field grouping with titles and collapsibility |
| `values`   | `Record<string, unknown>`                   | Current field values                                   |
| `onChange` | `(values: Record<string, unknown>) => void` | Value change handler                                   |

**Supported Field Types**:

| Type       | Rendered As                                         |
| ---------- | --------------------------------------------------- |
| `text`     | Text input                                          |
| `url`      | URL input                                           |
| `password` | Password input                                      |
| `number`   | Number input with min/max                           |
| `textarea` | Multi-line textarea                                 |
| `boolean`  | Switch toggle                                       |
| `select`   | Dropdown with options                               |
| `tags`     | Tag input (Enter/comma-delimited, removable badges) |

**Conditional Visibility**: Fields support a `showIf` property that conditionally hides them based on other field values. Supported operators include `eq`, `neq`/`ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `not_contains`, and `in`. Multiple conditions are ANDed together.

**Field Grouping**: When `groups` are provided, fields are rendered inside collapsible card sections ordered by the group's `order` property. Groups with `collapsible: true` start collapsed by default (unless `collapsed: false`). Ungrouped fields render first above any groups.

**Field Deduplication**: Both fields and groups are deduplicated by name (first occurrence wins) to handle cases where pipeline plugins might register duplicate fields.

## GenerationProgress

**File**: `src/components/works/detail/generator/GenerationProgress.tsx`

Displays the real-time progress of an active generation run.

**Visual Elements**:

| Element         | Description                                                    |
| --------------- | -------------------------------------------------------------- |
| Spinner         | Animated spinning SVG icon in a primary-colored circle         |
| Title           | "Generating" with animated trailing dots (cycling every 500ms) |
| Step Text       | Current generation step description from `getStepText()`       |
| Items Processed | Count of processed items from `getItemsProcessedText()`        |
| Progress Bar    | Horizontal bar with percentage from `getStepProgress()`        |
| Info Note       | Message explaining the user can close the page safely          |

**Utility Functions**: The progress display uses three helper functions from `src/lib/utils/generator-steps.ts`:

| Function                        | Description                                                       |
| ------------------------------- | ----------------------------------------------------------------- |
| `getStepProgress(status)`       | Returns a percentage (0-100) based on the current generation step |
| `getStepText(status, fallback)` | Returns a human-readable description of the current step          |
| `getItemsProcessedText(status)` | Returns text like "5 of 20 items processed"                       |

## Server Actions Used

| Action                | Source                        | Description                                            |
| --------------------- | ----------------------------- | ------------------------------------------------------ |
| `generateItems`       | `dashboard/generator.ts`      | Starts full item generation                            |
| `updateItems`         | `dashboard/generator.ts`      | Starts an update-only generation run                   |
| `getFormSchema`       | `dashboard/generator-form.ts` | Fetches dynamic form schema for a work + pipeline |
| `getGlobalFormSchema` | `dashboard/generator-form.ts` | Fetches global form schema (used by AI chat)           |
