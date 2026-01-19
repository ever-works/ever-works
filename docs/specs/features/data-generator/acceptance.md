# Data Generator - Acceptance Criteria

## Core Functionality

### AC-1: Repository Management

- [ ] Creates data repository if not exists
- [ ] Clones existing repository for updates
- [ ] Pulls latest changes before modifications
- [ ] Handles private and public repositories

### AC-2: Configuration File

- [ ] Reads existing `config.yml`
- [ ] Creates `config.yml` for new directories
- [ ] Increments version on each update
- [ ] Preserves metadata (initial_prompt, timestamps)
- [ ] Updates `last_request_data` with current DTO

### AC-3: Item Management

- [ ] Writes items as individual JSON files in `items/`
- [ ] Uses slug as filename (`{slug}.json`)
- [ ] Removes items that no longer exist (RECREATE mode)
- [ ] Preserves items not in current batch (CREATE_UPDATE)

### AC-4: Category/Tag Management

- [ ] Writes `categories.yml` with all categories
- [ ] Writes `tags.yml` with all tags
- [ ] Writes `brands.yml` with all brands
- [ ] Preserves priority ordering in categories

## Generation Modes

### AC-5: CREATE_UPDATE Mode

- [ ] Merges new items with existing
- [ ] Updates existing items by slug match
- [ ] Preserves manual edits (featured, order)
- [ ] Adds new items without removing existing

### AC-6: RECREATE Mode

- [ ] Removes all existing items
- [ ] Writes only newly generated items
- [ ] Resets categories and tags
- [ ] Preserves config metadata

## Git Operations

### AC-7: Direct Commit

- [ ] Commits all changes in single commit
- [ ] Uses meaningful commit message
- [ ] Pushes to main branch
- [ ] Handles push failures gracefully

### AC-8: Pull Request Mode

- [ ] Creates feature branch with timestamp
- [ ] Commits changes to feature branch
- [ ] Creates PR with summary
- [ ] Returns PR URL and number

## Item Merging

### AC-9: Merge Logic

- [ ] Matches items by slug
- [ ] Existing featured flag preserved
- [ ] Existing order field preserved
- [ ] New fields from generation applied
- [ ] Removed items handled per mode

## Output

### AC-10: Result Format

- [ ] Returns success boolean
- [ ] Returns stats (new, updated, total counts)
- [ ] Returns metrics from generation
- [ ] Returns PR info if applicable
- [ ] Returns error message on failure

## Error Handling

### AC-11: Recovery

- [ ] Git clone failures retried
- [ ] Write failures logged, non-fatal
- [ ] Push failures reported to user
- [ ] Partial success handled gracefully

## File Structure

### AC-12: Repository Structure

- [ ] `config.yml` at root
- [ ] `items/` directory with JSON files
- [ ] `categories.yml` at root
- [ ] `tags.yml` at root
- [ ] `brands.yml` at root
