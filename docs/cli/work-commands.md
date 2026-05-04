---
id: work-commands
title: CLI Work Commands
sidebar_label: Work Commands
sidebar_position: 4
---

# CLI Work Commands

The `work` command group provides 12 subcommands for managing works through the Ever Works CLI. These commands cover the full work lifecycle: creation, content generation, deployment, and maintenance.

## Architecture

```
apps/cli/src/commands/work/
  index.ts                    # Commander work command group
  create.ts                   # Interactive work creation
  list.ts                     # List works with roles
  generate.ts                 # AI content generation flow
  update.ts                   # Update work and repository
  submit-item.ts              # Submit an item to a work
  remove-item.ts              # Remove an item from a work
  regenerate-markdown.ts      # Regenerate readme markdown
  update-website.ts           # Update the website repository
  deploy.ts                   # Deploy website with state machine
  delete.ts                   # Delete a work
  status.ts                   # Poll generation status
  plugins.ts                  # Manage work plugins
  work-prompt.service.ts # Shared prompts and work selection
  generate-prompt.service.ts  # Generation-specific prompts
```

All commands require authentication (via `requireAuth()`) and use the shared API service to communicate with the backend.

## Commands

### `ever-works work create`

Interactive work creation. Walks through:

1. **Provider discovery**: Fetches git providers and deploy providers in parallel, checks connections for all git providers
2. **Git provider selection**: Prompts to select from enabled and connected git providers
3. **Deploy provider selection**: Optional; skipped if none are available
4. **Organization selection**: Fetches organizations from the selected git provider; defaults to personal account
5. **Work details**: Prompts for name, slug, and description
6. **Slug conflict handling**: If slug already exists (409), offers to use an incremented slug, enter a custom slug, or cancel

### `ever-works work list`

List all works the user has access to.

| Option        | Default | Description     |
| ------------- | ------- | --------------- |
| `--limit <n>` | --      | Maximum results |

Displays works with their roles (owned vs. shared) and generation status.

### `ever-works work generate`

Full content generation flow with pipeline and provider selection.

**Steps:**

1. Select a work (must have edit permission; generation must not already be in progress)
2. Verify git provider connection
3. Load generator configuration and form schema
4. **Pipeline selection**: Choose a generation pipeline (e.g., `agent-pipeline`, `standard-pipeline`, `claude-code`); re-fetches schema for pipeline-specific filtering
5. **Provider selection**: Select AI provider, search provider, content extraction, and screenshot providers based on the pipeline's requirements
6. **Required fields**: Work name (read-only) and generation prompt (pre-filled from last generation)
7. **Dynamic plugin fields**: Pipeline-specific configuration fields from the schema
8. **Generation options** (existing works only): Generation method (`CREATE_UPDATE` or `RECREATE`), PR option, website repository creation method
9. **Validation**: Checks for unconfigured providers before starting
10. **Confirmation**: Displays a summary and prompts for confirmation
11. **Start generation**: Submits to the API and suggests using `work status` to monitor progress

For new works, generation method defaults to `CREATE_UPDATE` without prompting.

### `ever-works work update`

Update an existing work and its repository. Used for simple updates without re-configuring providers.

### `ever-works work deploy`

Deploy the website for a work. Implements a state machine with four states:

| State | Condition                               | Behavior                                       |
| ----- | --------------------------------------- | ---------------------------------------------- |
| **A** | No deploy provider set                  | Prompt to select provider, set it, then deploy |
| **B** | Has provider, cannot deploy, shared dir | Show message that owner must configure token   |
| **C** | Has provider, cannot deploy, owned dir  | Prompt to configure token or switch provider   |
| **D** | Has provider, can deploy                | Execute deployment                             |

**Deployment execution (State D):**

1. Look up existing deployment
2. Fetch and select deployment team (if available)
3. Show deployment summary and confirm
4. Deploy via API
5. Poll deployment status every 5 seconds until terminal state (`READY`, `ERROR`, `CANCELED`, `TIMEOUT`)
6. Display final website URL

The work must have content generated before deploying.

### `ever-works work status`

Monitor work generation status in real time.

- Polls the API every 5 seconds with a 30-minute timeout
- Shows dynamic step progress, items processed count, and elapsed time
- Terminal states: `GENERATED` (success), `ERROR`, `CANCELLED`
- Handles `SIGINT` (Ctrl+C) gracefully
- Prints a work summary on completion (name, generation status, deploy provider, deployment state, website URL)

### `ever-works work submit-item`

Submit a new item to an existing work.

### `ever-works work remove-item`

Remove an item from a work.

### `ever-works work regenerate-markdown`

Regenerate the readme markdown file for a work.

### `ever-works work update-website`

Update the website repository for a work without running a full generation.

### `ever-works work delete`

Delete a work and its associated repositories. Prompts for confirmation.

### `ever-works work plugins`

Manage plugins configured for a specific work.

## Shared Services

### WorkPromptService

Provides reusable interactive prompts:

- `promptWorkSelection()`: Lists works with role indicators, returns selected work with role and ownership info
- `promptGitProviderSelection()`: Choose from available git providers
- `promptDeployProviderSelection()`: Choose from available deploy providers
- `promptWorkCreation()`: Collect name, slug, description, and organization
- `promptSlugConflictResolution()`: Handle slug conflicts with suggested alternatives
- `formatSelectedWork()`: Format work display with role badge
- `canEdit(role)`: Check if the user's role permits edit operations

### GeneratePromptService

Provides generation-specific prompts:

- `promptPipelineSelection()`: Select a generation pipeline from available options
- `promptIndividualProviders()`: Select providers per category based on schema
- `promptRequiredFields()`: Collect name and prompt
- `promptDynamicFields()`: Collect plugin-specific configuration from schema
- `promptGenerationOptions()`: Choose generation method, PR option, and website creation method
- `displayGenerationSummary()`: Print a formatted summary of all generation parameters
