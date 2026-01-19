# Markdown Generator - Acceptance Criteria

## Core Functionality

### AC-1: Repository Management

- [ ] Creates markdown repository if not exists
- [ ] Clones existing repository for updates
- [ ] Handles repository initialization
- [ ] Supports both private and public repos

### AC-2: README Generation

- [ ] Generates README.md from items and categories
- [ ] Includes table of contents
- [ ] Groups items by category
- [ ] Links to detail pages
- [ ] Includes directory name and description

### AC-3: Detail Page Generation

- [ ] Creates `details/` directory
- [ ] Generates `{slug}.md` for each item
- [ ] Includes item name, description, source URL
- [ ] Includes tags and badges
- [ ] Includes markdown content if available

## README Structure

### AC-4: Header Section

- [ ] Default header with name and description
- [ ] Custom header support via config
- [ ] Overwrite default header option
- [ ] Prepend custom header option

### AC-5: Table of Contents

- [ ] Lists all categories as links
- [ ] Priority categories first
- [ ] Alphabetical for non-priority
- [ ] Anchor links work correctly

### AC-6: Category Sections

- [ ] Section for each category
- [ ] Table with Name and Description columns
- [ ] Links to detail pages
- [ ] Featured items marked
- [ ] Items sorted by order/name

### AC-7: Footer Section

- [ ] Default footer with credits
- [ ] Custom footer support via config
- [ ] Overwrite default footer option
- [ ] Append custom footer option

## Git Operations

### AC-8: Direct Commit

- [ ] Commits README and all detail pages
- [ ] Single commit for all changes
- [ ] Pushes to main branch
- [ ] Meaningful commit message

### AC-9: Pull Request Mode

- [ ] Creates feature branch
- [ ] Commits to feature branch
- [ ] Creates PR with summary
- [ ] PR includes change statistics

## Detail Pages

### AC-10: Content Quality

- [ ] Item name as H1
- [ ] Description included
- [ ] Markdown content rendered
- [ ] Links section with source URL
- [ ] Tags displayed
- [ ] Last updated date

### AC-11: File Management

- [ ] Creates new detail files
- [ ] Updates existing detail files
- [ ] Removes detail files for deleted items
- [ ] Handles special characters in slugs

## Integration

### AC-12: Data Source

- [ ] Receives items from DataGenerator
- [ ] Receives categories and tags
- [ ] Uses contentCache for markdown
- [ ] Handles empty item sets

## Error Handling

### AC-13: Recovery

- [ ] Clone failures retried
- [ ] Individual file failures logged
- [ ] Push failures reported
- [ ] Partial success possible

## Output

### AC-14: Result Format

- [ ] Returns success boolean
- [ ] Returns PR info if applicable
- [ ] Returns error message on failure
