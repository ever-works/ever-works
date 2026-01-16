# Items Generation - Acceptance Criteria

## Core Functionality

### AC-1: Pipeline Execution

- [ ] Pipeline executes all 14 steps in correct order
- [ ] Parallel steps (4a, 4b) execute concurrently
- [ ] Each step receives and returns updated GenerationContext
- [ ] Pipeline completes within 5-hour timeout

### AC-2: Checkpointing

- [ ] Checkpoint saved after each step completion
- [ ] Pipeline can resume from last checkpoint on failure
- [ ] Checkpoint data persists for 1 hour
- [ ] Context is correctly serialized/deserialized

### AC-3: Error Handling

- [ ] Individual step failures are logged with context
- [ ] Failed steps can be retried
- [ ] Partial results are preserved on failure
- [ ] User receives meaningful error messages

## Step-Specific Criteria

### Step 1: Prompt Comparison

- [ ] Detects related prompts (similarity > threshold)
- [ ] Detects unrelated prompts (triggers fresh start)
- [ ] Uses existing prompt from directory if available
- [ ] Skipped for new directories

### Step 2: Prompt Processing

- [ ] Extracts subject from prompt
- [ ] Extracts categories mentioned in prompt
- [ ] Extracts URLs mentioned in prompt
- [ ] Merges with user-provided categories

### Step 3: Domain Detection

- [ ] Classifies into correct domain type
- [ ] Provides confidence score
- [ ] Returns domain-specific metadata
- [ ] Handles ambiguous prompts gracefully

### Step 4a: AI Item Generation

- [ ] Only runs when `ai_first_generation_enabled`
- [ ] Generates items directly from AI knowledge
- [ ] Respects custom prompt if provided
- [ ] Items have required fields (name, description, source_url)

### Step 4b: Search Query Generation

- [ ] Generates up to `max_search_queries` queries
- [ ] Queries are diverse and relevant
- [ ] Respects custom prompt if provided
- [ ] Handles short/vague prompts

### Step 5: Web Page Retrieval

- [ ] Executes search via Tavily API
- [ ] Retrieves up to `max_results_per_query` per query
- [ ] Includes user-provided source URLs
- [ ] Populates contentCache for later use
- [ ] Handles rate limiting gracefully

### Step 6: Content Filtering

- [ ] Filters pages below relevance threshold
- [ ] Relevance score is 0-1
- [ ] Respects custom prompt if provided
- [ ] Passes through if filtering disabled

### Step 7: Item Extraction

- [ ] Extracts items from all filtered pages
- [ ] Handles large pages via chunking
- [ ] Items match ItemData schema
- [ ] Respects custom prompt if provided
- [ ] No duplicate items from same page

### Step 8: Data Aggregation

- [ ] Merges AI items with web-extracted items
- [ ] Identifies duplicates (name, URL similarity)
- [ ] Only outputs truly new items
- [ ] Respects custom prompt if provided
- [ ] Preserves featured flag from existing items

### Step 9: Category Processing

- [ ] Assigns one category per item
- [ ] Assigns 1-3 tags per item
- [ ] Creates new categories if existing too large (>50)
- [ ] Maintains consistency with existing categories
- [ ] Respects priority categories ordering

### Step 10: Source Validation

- [ ] Validates URLs are accessible
- [ ] Classifies URL type (official, github, etc.)
- [ ] Filters out aggregator sites
- [ ] Respects custom prompt if provided

### Step 11: Badge Processing

- [ ] Only runs when `badge_evaluation_enabled`
- [ ] Evaluates domain-specific badges
- [ ] Badges are stored on items
- [ ] Handles missing badge data gracefully

### Step 12: Markdown Generation

- [ ] Generates markdown for each item
- [ ] Uses cached content when available
- [ ] Markdown includes key item details
- [ ] Handles items without source content

## Output Quality

### Items

- [ ] All items have required fields
- [ ] No duplicate items in output
- [ ] Slugs are unique and URL-safe
- [ ] Source URLs are valid

### Categories

- [ ] No duplicate categories
- [ ] Priority categories appear first
- [ ] Category names are normalized

### Metrics

- [ ] Accurate count of URLs scanned
- [ ] Accurate count of items extracted
- [ ] Token usage tracked (if available)
- [ ] Cost calculated (if available)

## Performance

- [ ] Completes within reasonable time (<30 min for typical directory)
- [ ] Memory usage stays bounded
- [ ] API calls are batched where possible
- [ ] Concurrent operations don't cause race conditions

## Integration

- [ ] Works with Trigger.dev orchestration
- [ ] Context compatible with Data/Markdown/Website generators
- [ ] Advanced prompts loaded from database
- [ ] Existing directory data preserved appropriately
