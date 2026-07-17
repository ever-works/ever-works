```markdown
# ever-works Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill covers the core development patterns, coding conventions, and collaborative workflows used in the `ever-works` TypeScript monorepo. It is designed to help contributors quickly understand how to structure code, write tests, and participate in feature planning, internationalization, and full-stack feature development. The repository does not use a specific framework but follows clear conventions and leverages tools like Vitest for testing.

## Coding Conventions

**File Naming**
- Use `camelCase` for file and directory names.
  - Example: `userController.ts`, `featurePlan.md`

**Import Style**
- Use relative imports for internal modules.
  - Example:
    ```typescript
    import { getUser } from './userService'
    ```

**Export Style**
- Use named exports.
  - Example:
    ```typescript
    // userService.ts
    export function getUser(id: string) { ... }
    export function createUser(data: UserData) { ... }
    ```

**Commit Messages**
- Follow [Conventional Commits](https://www.conventionalcommits.org/) with prefixes like `feat`, `docs`, `i18n`.
  - Example: `feat(api): add user profile endpoint`

## Workflows

### Feature Specification & Planning
**Trigger:** When defining or updating requirements and implementation plans for a new or enhanced feature  
**Command:** `/new-feature-spec`

1. Create or update the feature specification:
    - `docs/specs/features/[feature]/spec.md`
2. Create or update the implementation plan:
    - `docs/specs/features/[feature]/plan.md`
3. Create or update the task breakdown:
    - `docs/specs/features/[feature]/tasks.md`

**Example:**
```
docs/specs/features/user-notifications/spec.md
docs/specs/features/user-notifications/plan.md
docs/specs/features/user-notifications/tasks.md
```

---

### Internationalization (i18n) Updates
**Trigger:** When adding or modifying UI text that requires translation  
**Command:** `/update-i18n`

1. Edit or add keys in the source locale:
    - `apps/web/messages/en.json`
2. Edit or add corresponding keys in other locales:
    - `apps/web/messages/ar.json`
    - `apps/web/messages/de.json`
    - etc.

**Example:**
```json
// en.json
{
  "welcome": "Welcome",
  "logout": "Log out"
}

// de.json
{
  "welcome": "Willkommen",
  "logout": "Abmelden"
}
```

---

### Feature Development (API & Web)
**Trigger:** When implementing a new major feature spanning backend and frontend  
**Command:** `/new-feature`

1. Backend:
    - Add or update controllers, services, DTOs, migrations, entities, and tests in:
      - `apps/api/src/**/*.ts`
      - `apps/api/src/migrations/*.ts`
      - `packages/agent/src/**/*.ts`
2. Frontend:
    - Add or update API client, server actions, routes, sidebar entries, UI components, and tests in:
      - `apps/web/src/**/*.tsx`
      - `apps/web/src/**/*.ts`
      - `apps/web/src/components/**/*.tsx`
      - `apps/web/src/lib/api/*.ts`
3. Update shared types and constants as needed.

**Example:**
```typescript
// apps/api/src/controllers/userController.ts
export function getUserProfile(req, res) { ... }

// apps/web/src/components/UserProfile.tsx
export function UserProfile({ userId }: { userId: string }) { ... }
```

## Testing Patterns

- Use [Vitest](https://vitest.dev/) for unit and integration tests.
- Test files follow the pattern: `*.spec.ts`
- Place test files alongside the code they test or in a dedicated `__tests__` directory.

**Example:**
```typescript
// userService.spec.ts
import { describe, it, expect } from 'vitest'
import { getUser } from './userService'

describe('getUser', () => {
  it('returns user data for a valid ID', () => {
    expect(getUser('123')).toEqual({ id: '123', name: 'Alice' })
  })
})
```

## Commands

| Command             | Purpose                                                        |
|---------------------|----------------------------------------------------------------|
| /new-feature-spec   | Start or update a feature specification and planning docs      |
| /update-i18n        | Add or update i18n strings for new or changed UI text         |
| /new-feature        | Begin development of a new feature across API and Web         |
```
