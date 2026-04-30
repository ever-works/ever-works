---
id: import-flow-components
title: Import Flow Components
sidebar_label: Import Flow
sidebar_position: 27
---

# Import Flow Components

## Overview

The import flow components implement a multi-step wizard for importing directories from external sources (URLs or git repositories) into Ever Works. The flow supports two modes: "import" (copy data into a new repository) and "link existing" (connect to an already-existing Ever Works repository). All components live in `apps/web/src/components/directories/import/` and are exported through a barrel `index.ts`.

## Architecture

```
Import Flow (multi-step wizard)
│
├── Step 1: ImportSourceStep
│   ├── Source method selection (URL or Repository)
│   ├── URL input with format detection
│   ├── RepositorySelector (from git provider)
│   └── Analyze button → analyzeRepository / analyzeForLinking
│
├── Step 2: ImportModeSelector
│   ├── ModeOption: "Import Copy" (creates new repo)
│   └── ModeOption: "Link Existing" (connects to existing repo)
│
├── Step 3 (Import mode): ImportConfigureStep
│   ├── Detected format display
│   ├── Directory name input
│   ├── SlugConflictWarning (if slug exists)
│   ├── Sync toggle (Switch component)
│   ├── AI provider selection (for awesome_readme type)
│   ├── Organization selector
│   └── Import button → importDirectory
│
└── Step 3 (Link mode): LinkExistingConfirm
    ├── Repo status display (data, markdown, website)
    ├── Missing repo warnings
    └── Confirm link → createDirectory with linked repos
```

The parent page component orchestrates step transitions, holding the current step index and the accumulated form state. Each step component receives its data via props and communicates back through callbacks.

## Components

### ImportSourceStep

**File:** `apps/web/src/components/directories/import/ImportSourceStep.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `onAnalyze` | `(result: AnalyzeResult) => void` | Callback with analysis results |
| `connections` | `OAuthConnectionDto[]` | Available git provider connections |
| `isAnalyzing` | `boolean` | Whether analysis is in progress |

The first step in the import flow. It presents two source methods in a two-column layout:

1. **URL source** - A text input for pasting a repository or list URL. Supported formats are displayed below the input (GitHub, GitLab, awesome lists, etc.).
2. **Repository source** - A `RepositorySelector` component that connects to the user's git provider (via their OAuth connection) and lets them browse and select a repository from their account.

When the user clicks "Analyze", the component calls either `analyzeRepository` (for URLs) or `analyzeForLinking` (for repository selections) server actions. The results include the detected format type, repository metadata, and whether the repo already exists in Ever Works.

```tsx
<ImportSourceStep
    onAnalyze={(result) => {
        setAnalysisResult(result);
        setStep(2);
    }}
    connections={userConnections}
    isAnalyzing={isPending}
/>
```

### ImportModeSelector

**File:** `apps/web/src/components/directories/import/ImportModeSelector.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `onSelect` | `(mode: ImportMode) => void` | Callback when a mode is chosen |
| `analysisResult` | `AnalyzeResult` | Results from the analysis step |

Presents two mode cards side by side:

| Mode | Value | Description |
|------|-------|-------------|
| Import Copy | `'import'` | Creates a new Ever Works repository with the imported data. The original source is copied. |
| Link Existing | `'link_existing'` | Connects to an existing Ever Works repository structure without copying data. |

Each mode is rendered as a `ModeOption` card with an icon, title, description, and a list of what the mode includes. The cards are styled as selectable options with a border highlight on hover.

The `link_existing` mode is only available when the analysis detects that the repository already has an Ever Works structure.

```typescript
type ImportMode = 'import' | 'link_existing';
```

```tsx
<ImportModeSelector
    onSelect={(mode) => {
        setImportMode(mode);
        setStep(3);
    }}
    analysisResult={analysisResult}
/>
```

### ImportConfigureStep

**File:** `apps/web/src/components/directories/import/ImportConfigureStep.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `analysisResult` | `AnalyzeResult` | Results from the analysis step |
| `mode` | `ImportMode` | Selected import mode |
| `onImport` | `(config: ImportConfig) => void` | Callback when import is confirmed |
| `isPending` | `boolean` | Whether import is in progress |

The configuration step for the "import" mode. It renders multiple sections:

1. **Detected type display** - Shows the auto-detected format (e.g., "awesome_readme", "json_list", "csv") with an icon and description. If detection failed, a manual format selector is shown as a fallback.

2. **Directory name** - An `Input` field for naming the new directory. Pre-filled from the analysis result.

3. **Slug conflict warning** - If the generated slug conflicts with an existing repository, a `SlugConflictWarning` component is rendered with suggested alternatives.

4. **Sync toggle** - A `Switch` component to enable/disable automatic syncing with the source repository.

5. **AI provider selection** - Only shown for `awesome_readme` type imports. Lets the user select which AI provider to use for content extraction.

6. **Organization selector** - If the user belongs to organizations, lets them assign the directory to one.

7. **Attribution note** - Informational text about source attribution.

8. **Import button** - Triggers the `importDirectory` server action with the configured options.

```tsx
<ImportConfigureStep
    analysisResult={analysisResult}
    mode="import"
    onImport={handleImport}
    isPending={isPending}
/>
```

### SlugConflictWarning

**File:** `apps/web/src/components/directories/import/SlugConflictWarning.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `conflicts` | `string[]` | List of conflicting repository names/slugs |
| `suggestedSlug` | `string` | Automatically generated alternative slug |
| `onUseSuggested` | `() => void` | Callback to apply the suggested slug |

An amber-colored warning banner displayed when the desired directory slug already exists. It shows:

- A warning icon with explanatory text.
- The list of conflicting repository names.
- A clickable button to apply the suggested alternative slug.

```tsx
<SlugConflictWarning
    conflicts={['my-directory', 'my-directory-data']}
    suggestedSlug="my-directory-2"
    onUseSuggested={() => setSlug('my-directory-2')}
/>
```

### LinkExistingConfirm

**File:** `apps/web/src/components/directories/import/LinkExistingConfirm.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `analysisResult` | `AnalyzeResult` | Results from the analysis step |
| `onConfirm` | `(config: LinkConfig) => void` | Callback when link is confirmed |
| `onCancel` | `() => void` | Callback to go back |
| `isPending` | `boolean` | Whether linking is in progress |

A confirmation dialog for the "link existing" mode. It displays the status of each repository type:

| Repository | Status Indicators |
|------------|-------------------|
| Data repo | Found (green check) or Missing (amber warning) |
| Markdown repo | Found (green check) or Missing (amber warning) |
| Website repo | Found (green check) or Missing (amber warning) |

If any repositories are missing, the dialog offers two options:

1. **Continue without missing repos** - Links only the found repositories.
2. **Create missing repos** - Creates the missing repositories as part of the link operation.

```tsx
<LinkExistingConfirm
    analysisResult={analysisResult}
    onConfirm={handleLink}
    onCancel={() => setStep(2)}
    isPending={isPending}
/>
```

## Implementation Details

### Analysis Flow

The analysis step calls server actions that hit the backend API:

1. **`analyzeRepository(url)`** - For URL-based sources. The backend clones or fetches the repository, detects the format, counts items, and returns metadata.
2. **`analyzeForLinking(repoId)`** - For repository selections. Checks if the repo has an Ever Works structure (data repo, markdown repo, website repo).

The analysis result contains:

```typescript
interface AnalyzeResult {
    type: string;           // e.g., 'awesome_readme', 'json_list', 'csv'
    name: string;           // Suggested directory name
    slug: string;           // Generated slug
    itemCount: number;      // Detected number of items
    repoUrl: string;        // Source repository URL
    hasExistingStructure: boolean;  // Whether link_existing is available
    repos: {
        data: RepoStatus;
        markdown: RepoStatus;
        website: RepoStatus;
    };
}
```

### Import vs Link

The two modes result in different server action calls:

- **Import** calls `importDirectory` which clones the source, parses the content, creates a new Ever Works directory structure, and optionally sets up sync.
- **Link** calls `createDirectory` with pre-existing repository references, connecting the directory to already-existing repos without copying data.

### Slug Generation

Directory slugs are auto-generated from the directory name using a kebab-case transformation. If a conflict is detected (the slug or its variants like `slug-data` or `slug-website` already exist), the `SlugConflictWarning` is displayed and a numeric suffix is suggested (e.g., `my-directory-2`).

## Styling & Theming

| Element | Classes |
|---------|---------|
| Step container | `space-y-6` with card-like sections |
| Source method cards | `border border-border rounded-lg p-6 cursor-pointer hover:border-primary` |
| Active source card | `border-primary bg-primary/5` |
| Mode option cards | `border-2 rounded-xl p-6` with hover and selection states |
| Selected mode | `border-primary bg-primary/5` |
| Warning banner | `bg-warning/10 border border-warning/20 rounded-lg p-3` with amber text |
| Status indicators | Green check (`text-success`) or amber warning (`text-warning`) |
| Section dividers | `border-t border-border dark:border-border-dark` |

The import flow uses generous spacing (`space-y-6`, `gap-6`) for readability and clear visual separation between configuration sections.

## Usage Examples

### Complete Import Flow Page

```tsx
'use client';

import { useState, useTransition } from 'react';
import {
    ImportSourceStep,
    ImportModeSelector,
    ImportConfigureStep,
    LinkExistingConfirm,
} from '@/components/directories/import';
import type { ImportMode } from '@/components/directories/import';

export function ImportPage({ connections }) {
    const [step, setStep] = useState(1);
    const [analysisResult, setAnalysisResult] = useState(null);
    const [importMode, setImportMode] = useState<ImportMode>('import');
    const [isPending, startTransition] = useTransition();

    return (
        <div className="max-w-3xl mx-auto">
            {step === 1 && (
                <ImportSourceStep
                    onAnalyze={(result) => {
                        setAnalysisResult(result);
                        setStep(result.hasExistingStructure ? 2 : 3);
                    }}
                    connections={connections}
                    isAnalyzing={isPending}
                />
            )}
            {step === 2 && (
                <ImportModeSelector
                    onSelect={(mode) => {
                        setImportMode(mode);
                        setStep(3);
                    }}
                    analysisResult={analysisResult}
                />
            )}
            {step === 3 && importMode === 'import' && (
                <ImportConfigureStep
                    analysisResult={analysisResult}
                    mode={importMode}
                    onImport={handleImport}
                    isPending={isPending}
                />
            )}
            {step === 3 && importMode === 'link_existing' && (
                <LinkExistingConfirm
                    analysisResult={analysisResult}
                    onConfirm={handleLink}
                    onCancel={() => setStep(2)}
                    isPending={isPending}
                />
            )}
        </div>
    );
}
```

## Related Components

- [Directory Detail Components](./directory-detail-components.md) - The detail view that displays after import completes
- [Server Actions Deep Dive](./server-actions-deep-dive.md) - analyzeRepository, importDirectory, createDirectory actions
- [Settings Components](./settings-components.md) - GitProviderConnections needed for repository-based imports
- [UI Component Library](./ui-component-library.md) - Input, Button, Dialog, Switch used throughout the flow
