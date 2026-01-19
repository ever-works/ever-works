# Website Generator - Acceptance Criteria

## Core Functionality

### AC-1: Repository Detection

- [ ] Checks if website repository exists
- [ ] Skips creation if already exists
- [ ] Handles both user and organization repos

### AC-2: DUPLICATE Method

- [ ] Clones template repository locally
- [ ] Creates target repository in user account
- [ ] Force pushes template to target
- [ ] Cleans up local clone after
- [ ] Works for both users and organizations

### AC-3: CREATE_USING_TEMPLATE Method

- [ ] Uses GitHub template feature
- [ ] Creates repo from template
- [ ] Falls back to DUPLICATE on failure
- [ ] Handles template not found errors

## Repository Creation

### AC-4: Naming

- [ ] Uses `{directory-slug}-web` pattern
- [ ] Handles slug length limits
- [ ] URL-safe characters only

### AC-5: Configuration

- [ ] Sets repository description
- [ ] Creates as public by default
- [ ] Respects user's visibility preference
- [ ] Applies correct owner (user or org)

## Template

### AC-6: Template Source

- [ ] Uses configured template repository
- [ ] Uses correct branch (main by default)
- [ ] Template contains valid Next.js app
- [ ] Template is publicly accessible

## Auto-Update Feature

### AC-7: Configuration

- [ ] Auto-update can be enabled/disabled
- [ ] Beta version option (stage branch)
- [ ] Tracks last checked timestamp
- [ ] Tracks last updated timestamp
- [ ] Tracks last error if any

### AC-8: Update Process

- [ ] Fetches latest template changes
- [ ] Merges without overwriting customizations
- [ ] Commits and pushes updates
- [ ] Reports success/failure

## Error Handling

### AC-9: Creation Errors

- [ ] Template not found → clear error message
- [ ] Permission denied → report to user
- [ ] Rate limiting → retry with backoff
- [ ] Network errors → retry

### AC-10: Fallback Behavior

- [ ] CREATE_USING_TEMPLATE fails → try DUPLICATE
- [ ] DUPLICATE fails → report error
- [ ] Existing repo → skip gracefully

## Integration

### AC-11: Orchestration

- [ ] Called after DataGenerator and MarkdownGenerator
- [ ] Independent of generation results
- [ ] Can be skipped if repo exists

### AC-12: Deployment

- [ ] Repository deployable to Vercel
- [ ] Repository deployable manually
- [ ] Data repo URL configurable

## Output

### AC-13: Result Format

- [ ] Returns success boolean
- [ ] Returns repository URL on success
- [ ] Returns error message on failure

## Repository Structure

### AC-14: Template Contents

- [ ] Valid Next.js application
- [ ] Connects to data repository
- [ ] Responsive design
- [ ] Category/item pages work
- [ ] Search functionality
