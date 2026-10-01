# App Provisioner — agent template

> DRAFT — `ever-works/agents` → `templates/app-provisioner/README.md`.

The agent that works out how to build and run a repository as an Ever Works **App Work**, and proposes the App spec that
proves it. It reads the repository inside a sandbox that holds no secrets and can reach only the repository host and
public package and container registries, writes `.works/works.yml` (plus an overlay Dockerfile only when unavoidable)
and hands the proposal to the platform, which validates it, builds it, boots it and smoke-tests it.

## What is in this template

| Path                                    | Why it exists                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `.works/agent.yml`                      | The manifest: identity, permissions, the prompt paths, the kb seed and the tags |
| `SOUL.md`                               | Identity, mission, priorities and the hard rules the agent never breaks         |
| `skills.yml`                            | The one required Skill (`provision-app`) and why it is required                 |
| `prompts/system.md`                     | The session system prompt                                                       |
| `prompts/tasks/provision-repository.md` | The first provisioning run                                                      |
| `prompts/tasks/fix-verification.md`     | An iterate run resumed with red verification evidence                           |
| `kb/playbooks/detection-order.md`       | Which run-instruction source wins, and what counts as proof                     |
| `kb/playbooks/env-classification.md`    | Secret / build-time / source classification and exact-shape rules               |
| `kb/playbooks/bootstrap-risks.md`       | The risk kinds the report records and the spec-side answer for each             |
| `icon.svg`                              | The catalog avatar (Monochrome, `currentColor`)                                 |
| `eval/app-provisioner.yml`              | The eval cases, with their fixture trees and structured expectations            |

## Permissions

Every permission flag is `false`: the agent creates no agents, assigns no tasks, edits no skills, approves no work and
spends no budget of its own. It publishes nothing directly — the platform pushes and opens the pull request through the
Task's own finalize step, after the platform's checks pass. Its own commit and pull-request tools are refused for every
provisioning run.

## Related

- Skill: [`ever-works/skills`](https://github.com/ever-works/skills) → `skills/provision-app`.
- Program: `ever-works/platform` → `docs/specs/features/app-works/APW-04-app-provisioner/` (spec, plan, tasks).
