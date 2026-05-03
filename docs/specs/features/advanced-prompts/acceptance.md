# Advanced Prompts - Acceptance Criteria

## Backend

### AC-1: Database Entity

- [ ] `WorkAdvancedPrompts` entity exists with all 7 prompt fields
- [ ] One-to-one relationship with Work
- [ ] Cascade delete when work is deleted
- [ ] Timestamps (createdAt, updatedAt) are tracked

### AC-2: Repository

- [ ] `findByWorkId` returns prompts or null
- [ ] `createOrUpdate` creates new record if none exists
- [ ] `createOrUpdate` updates existing record if found
- [ ] `delete` removes record for work

### AC-3: Service

- [ ] `getAdvancedPrompts` returns prompts for work
- [ ] `updateAdvancedPrompts` requires editor role
- [ ] `updateAdvancedPrompts` sanitizes input
- [ ] `getPromptsForGeneration` returns prompts as context object

### AC-4: API Endpoints

- [ ] `GET /works/:id/advanced-prompts` returns current prompts
- [ ] `PUT /works/:id/advanced-prompts` updates prompts
- [ ] Proper error responses for not found, unauthorized
- [ ] Input validation (max 2000 chars per field)

## Pipeline Integration

### AC-5: Context Loading

- [ ] Prompts loaded in `ItemsGeneratorService.generateItems()`
- [ ] Prompts added to `GenerationContext.advancedPrompts`
- [ ] Prompts always reloaded fresh (not from checkpoint)

### AC-6: Prompt Appending

- [ ] `appendCustomPrompt` utility exists
- [ ] Empty/null prompts return base prompt unchanged
- [ ] Non-empty prompts appended with clear separator
- [ ] Whitespace trimmed from custom prompts

### AC-7: Step Integration

- [ ] ContentFilteringService uses `relevanceAssessment`
- [ ] AiItemGenerationService uses `itemGeneration`
- [ ] ItemExtractionService uses `itemExtraction`
- [ ] SearchQueryGenerationService uses `searchQuery`
- [ ] CategoryProcessingService uses `categorization`
- [ ] AiDeduplicator uses `deduplication`
- [ ] SourceValidationService uses `sourceValidation`

## Frontend

### AC-8: Settings Component

- [ ] `AdvancedPromptsSettings` component exists
- [ ] Collapsible section (collapsed by default)
- [ ] Expands on click
- [ ] Shows all 7 prompt fields

### AC-9: Form Fields

- [ ] Each field has: label, description, placeholder, textarea
- [ ] Textareas auto-resize
- [ ] Max 2000 characters enforced
- [ ] Character count shown (optional)

### AC-10: Data Loading

- [ ] Prompts loaded when section first expanded
- [ ] Loading spinner during fetch
- [ ] Existing values populated in form
- [ ] Empty values shown as empty textareas

### AC-11: Saving

- [ ] Save button at bottom of section
- [ ] Loading state during save
- [ ] Success toast on save
- [ ] Error toast on failure
- [ ] Form values preserved after save

### AC-12: Translations

- [ ] All text strings in translation files
- [ ] Title, subtitle translated
- [ ] Per-prompt: title, description, placeholder translated

## Security

### AC-13: Authorization

- [ ] Only editors and above can update prompts
- [ ] Viewers cannot see update endpoint
- [ ] Proper 403 response for unauthorized

### AC-14: Input Validation

- [ ] Max length enforced (2000 chars)
- [ ] HTML/script tags sanitized
- [ ] SQL injection prevented (via ORM)
- [ ] Null/undefined handled gracefully

## Quality

### AC-15: Build

- [ ] Backend builds without errors
- [ ] Frontend builds without errors
- [ ] No TypeScript errors
- [ ] No ESLint warnings

### AC-16: Testing

- [ ] Unit tests for service methods
- [ ] API endpoint tests
- [ ] Frontend component renders
