---
id: merge-policy
title: Merge Policy
sidebar_label: Merge Policy
---

# Merge Policy

Whether an Agent may **land** its own pull request is a policy you configure, not something the platform hardcodes. The default is conservative — Agents open pull requests, humans merge them — and you can loosen it, per Work or per Agent, as far as you are comfortable.

Note the distinction: _opening_ a pull request is an Agent permission (`canOpenPullRequests`). _Merging_ one is this policy.

## The five knobs

| Field                  | Platform default                      | Meaning                                                                 |
| ---------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| `allowAgentMerge`      | `false`                               | May an Agent land a pull request at all?                                |
| `requireGreenGate`     | `true`                                | The run's [quality gate](./quality-gates.md) must be green first.       |
| `requireHumanApproval` | `true`                                | A recorded human approval must exist first.                             |
| `allowedMergeMethods`  | `['squash']`                          | Strategies an Agent may use. An **empty list refuses every merge**.     |
| `protectedBranches`    | `['main','master','develop','stage']` | Branches an Agent may never merge **into**. Matched case-insensitively. |

## Four scopes, resolved field by field

A policy can be stored at four scopes. Least specific first:

```
platform default  <  tenant  <  organization  <  Work  <  Agent
```

Resolution is a **deep merge, not a replace**: the most specific scope that declares a field wins _for that field_. A Work that sets only `allowAgentMerge: true` still inherits `requireGreenGate`, `requireHumanApproval`, `allowedMergeMethods` and `protectedBranches` from the organization, then the tenant, then the platform default. An omitted or `null` key means "inherit" — never "false".

### Writing a policy

Each scope accepts an additive optional `mergePolicy` object on its existing update endpoint:

- `PATCH /api/works/:id` — the Work scope
- `PATCH /api/agents/:id` — the Agent scope (most specific)
- `PATCH /api/organizations/:id` — the organization scope

Pass `null` to clear a scope's override entirely and inherit everything. The tenant scope is resolvable and storable but has no HTTP write surface today — an operator-level ceiling there is set out of band.

### Previewing a policy

```
GET /api/merge-policy/resolve?workId=…&agentId=…
```

returns the complete effective `policy`, the `source` (the most specific scope that contributed anything, or `default`), and the full `chain` — least to most specific, starting at the platform default, with the fields each link actually contributed.

The chain matters: _"Agents may not merge here"_ is only actionable if the answer also says **where** that came from and which knob to change.

## Refusals

When a merge is refused, the decision carries a stable machine-readable code alongside the human explanation:

| Code                       | Meaning                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `agent-merge-disabled`     | `allowAgentMerge` is false at the winning scope.                              |
| `protected-branch`         | The pull request's base branch is protected.                                  |
| `target-branch-unknown`    | Branches are protected but the target could not be determined — fails closed. |
| `merge-method-not-allowed` | The requested strategy is not in `allowedMergeMethods`.                       |
| `gate-not-green`           | `requireGreenGate` is on and the gate is not green.                           |
| `human-approval-required`  | `requireHumanApproval` is on and no approval is on record.                    |

Every path that could land a pull request on an Agent's behalf routes through one decision point, so the answer is the same wherever it is asked.

## A worked example

You want Agents to land their own work on a Work, but only when the tests pass and never onto `main`:

```json
{
	"mergePolicy": {
		"allowAgentMerge": true,
		"requireHumanApproval": false
	}
}
```

`requireGreenGate` and `protectedBranches` are left out, so they keep the platform defaults — green gate required, `main` still protected.

## Related

- [Quality Gates](./quality-gates.md) · [Task Isolation](./task-isolation.md) · [Agents](./agents.md)
