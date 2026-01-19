# Ever Works Platform - Technical Specifications

This directory contains technical specifications for AI agents to understand and build features. These are **NOT** user-facing documentation - they are internal specs that describe how features work architecturally.

## Directory Structure

```
/specs/
├── README.md                          # This file
├── features/
│   ├── items-generation/              # Core item generation pipeline
│   │   ├── spec.md                    # Full specification
│   │   ├── acceptance.md              # Acceptance criteria
│   │   └── assets/                    # Diagrams, examples
│   ├── advanced-prompts/              # Per-directory custom prompts
│   ├── data-generator/                # Data repository management
│   ├── markdown-generator/            # README & detail page generation
│   └── website-generator/             # Website repository creation
├── architecture/
│   ├── pipeline-overview.md           # High-level pipeline architecture
│   ├── trigger-integration.md         # Trigger.dev integration
│   └── ai-service.md                  # AI provider abstraction
└── decisions/                         # Architecture Decision Records (ADRs)
    └── 001-pipeline-checkpointing.md
```

## How to Use These Specs

### For AI Agents

When implementing or modifying features:

1. **Read the spec.md** - Understand the full architecture
2. **Check acceptance.md** - Know what constitutes "done"
3. **Review related architecture docs** - Understand integration points
4. **Check ADRs** - Understand past decisions and constraints

### For Humans

Use these specs to:

- Onboard to unfamiliar features
- Understand system boundaries
- Plan new features with existing patterns
- Debug complex interactions

## Spec Format

Each feature spec follows this structure:

```markdown
# Feature Name

## Overview

Brief description of what this feature does.

## Architecture

How the feature is structured internally.

## Data Flow

How data moves through the feature.

## Interfaces

Key types, DTOs, and schemas.

## Integration Points

How this feature connects to other systems.

## Configuration

Available configuration options.

## File Locations

Key files implementing this feature.

## Examples

Code examples and usage patterns.
```

## Keeping Specs Updated

**IMPORTANT**: When modifying a feature, update its spec:

1. Add new fields/interfaces to the spec
2. Update diagrams if flow changes
3. Add new configuration options
4. Document breaking changes in ADRs

## Related Documentation

- User-facing docs: `/docs/` (separate repo: ever-works-docs)
- API documentation: Generated from NestJS decorators
- Component storybook: `/apps/web/storybook/`
