---
id: constants-module
title: Constants Module
sidebar_label: Constants Module
sidebar_position: 32
---

# Constants Module

The Constants Module (`@ever-works/agent/constants`) provides shared string constants used across the agent package for user-facing messages and error descriptions. These constants ensure consistency in status messages and error reporting throughout generation and import workflows.

## Module Structure

```
packages/agent/src/constants/
└── messages.ts    # All shared message constants
```

## Constants Reference

### GENERATION_CANCELLED

```typescript
export const GENERATION_CANCELLED = 'Generation cancelled by user';
```

Used when a user explicitly cancels an in-progress directory generation. This message is set on the directory's `generateStatus.error` field and surfaced in the UI.

**Used by**: Generation orchestrator, pipeline executor, cancellation handlers.

### IMPORT_CANCELLED

```typescript
export const IMPORT_CANCELLED = 'Import cancelled by user';
```

Used when a user cancels an in-progress directory import operation (e.g., importing from an Awesome List or existing data repository).

**Used by**: Import services, directory import handlers.

### GIT_TOKEN_NOT_AVAILABLE

```typescript
export const GIT_TOKEN_NOT_AVAILABLE = 'Git token not available';
```

Used when a git operation fails because no authentication token could be resolved. This can happen when:

- The user's OAuth token has expired or been revoked
- No personal access token (PAT) is configured in plugin settings
- The git provider plugin is not properly configured

**Used by**: Git facade, repository management services, notification system (triggers `notifyGitAuthExpired`).

## Usage

```typescript
import {
    GENERATION_CANCELLED,
    IMPORT_CANCELLED,
    GIT_TOKEN_NOT_AVAILABLE,
} from '@ever-works/agent/constants';

// Example: checking if generation was user-cancelled
if (directory.generateStatus?.error === GENERATION_CANCELLED) {
    // Handle user cancellation differently from errors
}

// Example: setting cancellation status
directory.generateStatus = {
    status: GenerateStatusType.CANCELLED,
    error: GENERATION_CANCELLED,
};
```

## Design Notes

These constants are intentionally simple string literals rather than an enum or object map. They are used for:

1. **Equality checks** -- Downstream code compares against these exact strings
2. **User-facing messages** -- The strings appear in UI status displays
3. **Log correlation** -- Searching logs for these messages helps trace cancellation and auth failure flows
