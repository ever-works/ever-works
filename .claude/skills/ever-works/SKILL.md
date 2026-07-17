```markdown
# ever-works Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the `ever-works` TypeScript codebase. It covers file naming, import/export styles, commit message conventions, and testing patterns. By following this guide, contributors can write code that is consistent, maintainable, and easy to review.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `userService.ts`, `orderProcessor.test.ts`

### Imports
- Use **alias imports** for modules.
  - Example:
    ```typescript
    import { UserService as US } from './userService';
    ```

### Exports
- Use **named exports** exclusively.
  - Example:
    ```typescript
    export const processOrder = () => { /* ... */ };
    export function validateUser() { /* ... */ }
    ```

### Commit Messages
- Follow the **conventional commit** style.
- Use the `fix` prefix for bug fixes.
- Keep commit messages concise (average ~71 characters).
  - Example:  
    ```
    fix: correct user validation logic in registration flow
    ```

## Workflows

### Code Contribution
**Trigger:** When adding or updating code  
**Command:** `/contribute`

1. Create a new branch for your feature or fix.
2. Write code using camelCase file names, alias imports, and named exports.
3. Write or update corresponding test files (`*.test.ts`).
4. Commit changes using the conventional commit format (e.g., `fix: ...`).
5. Open a pull request for review.

### Testing
**Trigger:** Before submitting or merging changes  
**Command:** `/test`

1. Identify test files matching the `*.test.*` pattern.
2. Run the test suite using the project's preferred test runner (framework unknown).
3. Ensure all tests pass before merging.

## Testing Patterns

- Test files follow the `*.test.*` naming convention (e.g., `userService.test.ts`).
- Place test files alongside or near the modules they test.
- The specific testing framework is not detected; use the project's existing test runner.

  Example test file:
  ```typescript
  import { processOrder } from './orderProcessor';

  describe('processOrder', () => {
    it('should process a valid order', () => {
      // Test implementation
    });
  });
  ```

## Commands
| Command      | Purpose                                 |
|--------------|-----------------------------------------|
| /contribute  | Start the code contribution workflow    |
| /test        | Run all tests in the codebase           |
```
