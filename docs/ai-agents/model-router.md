---
id: model-router
title: Model Router
sidebar_label: Model Router
sidebar_position: 2
---

# Model Router

The model router is an optional feature that routes AI tasks to different model tiers based on complexity. This enables cost optimization by using cheaper models for simple tasks and reserving expensive models for complex ones.

## Complexity Levels

Each AI task can be assigned a complexity level:

| Level | Use Case |
|-------|----------|
| `SIMPLE` | Straightforward extraction, formatting, short responses |
| `MEDIUM` | Multi-step reasoning, moderate context |
| `COMPLEX` | Large context windows, nuanced analysis, structured generation |

## Model Tiers

Complexity levels map to model tiers:

| Tier | Default Mapping | Description |
|------|----------------|-------------|
| `ECONOMY` | SIMPLE tasks | Cheapest models, fastest inference |
| `STANDARD` | MEDIUM tasks | Balanced cost and capability |
| `PREMIUM` | COMPLEX tasks | Most capable models |

## Auto-Escalation

When enabled, if a request to a lower-tier model fails, the router automatically escalates to the next tier:

```
ECONOMY → STANDARD → PREMIUM
```

This ensures reliability while still defaulting to cost-effective models. Auto-escalation is enabled by default.

## Configuration

Enable and configure the model router via environment variables:

```bash
# Enable model routing (default: false)
MODEL_ROUTING_ENABLED=false

# Enable auto-escalation on failure (default: true)
MODEL_ROUTING_AUTO_ESCALATION=true

# ECONOMY tier (for SIMPLE tasks)
MODEL_ROUTING_ECONOMY_PROVIDER=openrouter
MODEL_ROUTING_ECONOMY_MODEL=gpt-5-mini

# STANDARD tier (for MEDIUM tasks)
MODEL_ROUTING_STANDARD_PROVIDER=openrouter
MODEL_ROUTING_STANDARD_MODEL=gpt-5.1

# PREMIUM tier (for COMPLEX tasks)
MODEL_ROUTING_PREMIUM_PROVIDER=openrouter
MODEL_ROUTING_PREMIUM_MODEL=gpt-5.2
```

When `MODEL_ROUTING_ENABLED=false` (the default), all tasks use the default provider and model configured via `AI_DEFAULT_PROVIDER` and `{PROVIDER}_MODEL`.

## Cost Tracking

The model router includes a pricing database with cost information for models across all supported providers. It can:

- **Estimate cost** before making a request based on expected token usage
- **Calculate actual cost** after a request based on token counts
- **Compare costs** between different provider/model combinations
- **Find the cheapest model** for a given provider

## Provider Selection Strategies

Beyond complexity-based routing, the AI service supports additional selection strategies:

| Strategy | Behavior |
|----------|----------|
| **Cost-effective** | Selects the provider with the lowest per-token cost |
| **Fastest** | Prefers Groq when available, otherwise falls back to default |
| **Most capable** | Selects the provider with the largest context window |

These strategies are used internally by the platform for different types of operations.

## How It Works

1. A task is submitted with an optional `complexity` hint
2. The router maps the complexity to a model tier
3. The configured provider and model for that tier are selected
4. If the request fails and auto-escalation is enabled, the next tier is tried
5. Token usage and cost are tracked for observability
