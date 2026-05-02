# ADR-001: Pipeline Checkpointing for Fault Tolerance

## Status

**Accepted** - Implemented

## Date

2024-01-15

## Context

The items generation pipeline consists of 14 steps that can take 5-30 minutes to complete. Each step involves external API calls (AI providers, web search, GitHub) that can fail due to:

- Rate limiting
- Network timeouts
- Service outages
- Resource exhaustion

Without fault tolerance, a failure at step 12 would require re-running all previous steps, wasting time and API costs.

## Decision

Implement **checkpoint-based resumption** in the `PipelineExecutor`:

1. After each step completes successfully, save a checkpoint with:
    - List of completed steps
    - Serialized context state
    - Timestamp

2. On pipeline start, check for existing checkpoint:
    - If found and recent (<1 hour), resume from last completed step
    - If found and stale, clear and start fresh
    - If not found, start from beginning

3. Store checkpoints in CacheManager with 1-hour TTL

## Implementation

```typescript
// Save checkpoint after each step
async saveCheckpoint(workId: string, data: CheckpointData): Promise<void> {
    const key = `checkpoint:${workId}`;
    await this.cacheManager.set(key, data, 3600); // 1 hour TTL
}

// Load checkpoint on resume
async loadCheckpoint(workId: string): Promise<CheckpointData | null> {
    const key = `checkpoint:${workId}`;
    return this.cacheManager.get(key);
}

// Execution with checkpointing
async execute(context: GenerationContext): Promise<GenerationContext> {
    const checkpoint = await this.loadCheckpoint(context.work.id);

    let startIndex = 0;
    if (checkpoint && this.isRecent(checkpoint)) {
        context = this.deserializeContext(checkpoint.context);
        startIndex = checkpoint.completedSteps.length;
    }

    for (let i = startIndex; i < this.steps.length; i++) {
        context = await this.steps[i].run(context);
        await this.saveCheckpoint(context.work.id, {
            completedSteps: this.steps.slice(0, i + 1).map(s => s.name),
            context: this.serializeContext(context),
            timestamp: Date.now(),
        });
    }

    await this.clearCheckpoint(context.work.id);
    return context;
}
```

## Serialization Considerations

Not all context properties can be serialized:

| Property                      | Serializable | Handling            |
| ----------------------------- | ------------ | ------------------- |
| `dto`                         | Yes          | JSON stringify      |
| `items`, `categories`, `tags` | Yes          | JSON stringify      |
| `work`                   | No (Entity)  | Re-fetch on resume  |
| `contentCache` (Map)          | Yes          | Convert to Object   |
| `metrics`                     | Yes          | JSON stringify      |
| `advancedPrompts`             | Yes          | Always reload fresh |

**Critical**: `advancedPrompts` are always reloaded from database on resume to ensure latest values are used.

## Consequences

### Positive

- Failed pipelines can resume without full restart
- Reduces wasted API calls and costs
- Improves user experience (faster recovery)
- Enables long-running pipelines (5+ hours)

### Negative

- Adds complexity to pipeline execution
- Checkpoint storage uses memory/cache
- Context serialization has edge cases
- Stale checkpoints could cause issues

### Mitigations

- 1-hour TTL prevents stale checkpoints
- Clear checkpoints on successful completion
- Reload critical data (advancedPrompts) fresh
- Log checkpoint operations for debugging

## Alternatives Considered

### 1. No checkpointing (restart from beginning)

**Rejected**: Too costly for long pipelines, poor UX

### 2. Database-based checkpoints

**Rejected**: Overkill for single-instance execution, adds database load

### 3. Step-level retry only

**Rejected**: Doesn't help with service outages that persist

## Related

- [Pipeline Overview](../architecture/pipeline-overview.md)
- [Data Generator Spec](../features/data-generator/spec.md)
