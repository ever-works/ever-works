# Chat Does Everything — making the in-app AI chat a full platform operator

> **Status:** Wave 1 (foundation) implemented on `session/chat-everything`. This document + [`operations-inventory.json`](./operations-inventory.json) are the canonical spec and machine-readable manifest for the remaining waves.

> **Generated:** the operation tables below come from the inventory workflow (16 domain agents reading every controller in `apps/api/src` + a synthesis pass). Re-run that workflow to refresh.

## 1. Goal

Let a logged-in user do **everything the platform UI can do, from chat** — create/read/update/delete and operate every entity (works, items, agents, tasks, missions, ideas, skills, plugins, knowledge base, members, notifications, webhooks, budgets, organizations, templates, ...), ask for stats and reports, and have the agent render rich results (charts/tables/detail panels) in a side **canvas** instead of walls of text.

Hard rules, by product decision:

- **Auth-scoped** - every action runs as the logged-in user; the API enforces ownership exactly as for the UI.

- **Confirm before destructive** - delete/remove/revoke/disconnect/cancel/rotate-secret ask for confirmation in chat first.

- **No bulk** - one entity at a time. No "delete all my works" / "remove the last 10 tasks". Bulk endpoints are excluded and a runtime guard blocks smuggled id-arrays.

## 2. The numbers (scope of the full build)

| Metric                                            |     Count |
| ------------------------------------------------- | --------: |
| API endpoints inventoried                         |   **432** |
| exposed as single-entity chat tools               |   **419** |
| destructive (confirmation-gated)                  |    **56** |
| excluded (bulk / webhook / internal / auth-flow)  |    **15** |
| canvas components proposed (deduped catalog: 113) |   **129** |
| reports (analytical Q + chart)                    |    **95** |
| cross-cutting render/confirm primitives           |     **8** |
| **Total distinct chat capabilities**              | **~ 635** |

That lands between the "hundreds" and "500-1000" target. The chat agent currently ships ~47 hand-written tools - roughly **11% coverage**; this plan closes the rest.

## 3. Architecture

Four subsystems. The first three are implemented in Wave 1 (see section 10).

### 3.1 Manifest-driven tool generator

Mirrors `apps/mcp/src/openapi-tools/whitelist.ts` (which turns the OpenAPI spec into MCP tools), but emits web-chat Vercel-AI-SDK tools. A declarative registry (`apps/web/src/lib/ai/tools/generated/registry.ts`) maps **one platform operation -> one chat tool**; a factory (`generated/factory.ts`) turns each entry into a `tool()` whose `execute` routes through `generated/api-call.ts` -> the existing `serverFetch`/`serverMutation` client (JWT cookie = logged-in user). Adding coverage = adding registry rows, not new imperative code.

> **Why a registry, not runtime OpenAPI fetch?** The API only serves `/api/openapi.json` outside production (`NODE_ENV !== 'production'`), so the web chat cannot depend on it at runtime. The committed registry (validated against controllers by the inventory workflow) is production-safe and type-checked.

### 3.2 Confirmation gate (human-in-the-loop)

Destructive ops carry `requiresConfirmation`. The factory, when called without `confirmed: true`, returns a `__confirmationRequired` marker **instead of performing the mutation**. `ChatToolResult` renders a Confirm/Cancel card; Confirm sends a chat message so the model re-issues the call with `confirmed: true`. The mutation cannot run until the user clicks Confirm.

### 3.3 Single-entity / no-bulk guard

Bulk endpoints are never registered, **and** the factory rejects any call carrying an array of ids/members/emails in its body (`bulkRejected`), so the model cannot smuggle a batch through one call.

### 3.4 Canvas

A `CanvasProvider` + slide-over `CanvasOverlay` render artifacts produced by canvas tools (`renderChart`/`renderTable`/`renderStatCards`/`renderDetail`, recharts-backed). A `CanvasBridge` watches the message stream and opens the panel; `ChatToolResult` shows a chip linking back to it. Later waves add `show_component` (embed existing dashboard components: `ActivityTable`, `BudgetOverviewCard`, `SpendTrendCard`, ...) and `run_report` (the catalogued reports).

## 4. Cross-cutting primitives

| Tool             | Purpose                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open_canvas`    | Open/focus the side canvas panel and target a slot for subsequent renders within a chat turn.                                                                 |
| `render_table`   | Render any list/table canvasComponent (works, items, agents, tasks, members, deliveries) from a tool-result dataset with columns/sort/filter/pagination.      |
| `render_chart`   | Render a recharts visualization (line/bar/pie/donut/area/gauge/stacked) for stat and report outputs.                                                          |
| `render_detail`  | Render a detail/card panel for a single entity (WorkDetailCard, AgentDetailCard, TaskDetailCard, etc.).                                                       |
| `render_form`    | Render an editable/create form panel (SkillForm, KbDocumentForm, BudgetDetailCard, NotificationChannelForm) that submits via the matching create/update tool. |
| `show_component` | Embed an existing dashboard component (ActivityTable, BudgetOverviewCard, AgentCard, SpendTrendCard, ItemsList) into the canvas by name + props.              |
| `run_report`     | Execute one of the 95 catalogued reports: fetch source data, aggregate, and render via render_chart/render_table into the canvas.                             |
| `confirm_action` | Confirmation gate primitive: present a structured confirm card for any destructive/requiresConfirmation tool and block execution until the user approves.     |

## 5. Operations inventory by domain

Per-domain endpoint coverage. Full field-level detail (params, every excluded endpoint + reason) is in [`operations-inventory.json`](./operations-inventory.json).

| Domain                            | Endpoints | Chat tools | Destructive | Excluded |  Canvas | Reports |
| --------------------------------- | --------: | ---------: | ----------: | -------: | ------: | ------: |
| works-core                        |        75 |         75 |          11 |        0 |      11 |       8 |
| works-items-taxonomy              |        30 |         26 |           4 |        4 |       6 |       5 |
| generation-comparisons-schedule   |        18 |         18 |           2 |        0 |       4 |       4 |
| website-deploy-git                |        36 |         32 |           3 |        4 |       6 |       4 |
| agents                            |        28 |         28 |           5 |        0 |      10 |       6 |
| tasks                             |        21 |         21 |           5 |        0 |       5 |       8 |
| missions-ideas-workagent          |        38 |         38 |           4 |        0 |      10 |       8 |
| plugins-integrations              |        25 |         24 |           3 |        1 |      12 |       5 |
| skills                            |        11 |         11 |           2 |        0 |       5 |       3 |
| knowledge-base                    |        22 |         22 |           3 |        0 |      13 |       8 |
| orgs-tenants-members              |        17 |         17 |           3 |        0 |       6 |       5 |
| auth-account-security             |        32 |         29 |           5 |        3 |       8 |       5 |
| notifications                     |        17 |         17 |           1 |        1 |       7 |       6 |
| budgets-usage-billing             |         9 |          9 |           1 |        0 |       6 |       6 |
| email-comms                       |        10 |          9 |           1 |        1 |       5 |       5 |
| activity-webhooks-files-templates |        43 |         43 |           3 |        1 |      15 |       9 |
| **TOTAL**                         |   **432** |    **419** |      **56** |   **15** | **129** |  **95** |

### 5.1 Full chat-tool list (every single-entity operation)

<details><summary><b>works-core</b> - 72 tools</summary>

| Tool                                | Method / Path                                      | Kind        | Confirm | Canvas               |
| ----------------------------------- | -------------------------------------------------- | ----------- | :-----: | -------------------- |
| `list_works`                        | `GET /api/works`                                   | read        |         | WorksList            |
| `get_work_stats`                    | `GET /api/works/stats`                             | read        |         | WorkStatsCard        |
| `list_website_templates`            | `GET /api/works/website-templates`                 | read        |         | TemplatesList        |
| `create_work`                       | `POST /api/works`                                  | create      |         | WorkDetailCard       |
| `quick_create_work`                 | `POST /api/works/quick-create`                     | create      |         | WorkDetailCard       |
| `get_work`                          | `GET /api/works/:id`                               | read        |         | WorkDetailCard       |
| `update_work`                       | `PUT /api/works/:id`                               | update      |         |                      |
| `patch_work`                        | `PATCH /api/works/:id`                             | update      |         |                      |
| `rotate_activity_sync_secret`       | `POST /api/works/:id/activity-sync/rotate-secret`  | action      |   yes   |                      |
| `get_work_items`                    | `GET /api/works/:id/items`                         | read        |         | ItemsList            |
| `get_export_items_settings`         | `GET /api/works/:id/export-items/settings`         | read        |         |                      |
| `export_work_items`                 | `GET /api/works/:id/export-items`                  | action      |         |                      |
| `get_import_items_settings`         | `GET /api/works/:id/import-items/settings`         | read        |         |                      |
| `get_import_items_sample`           | `GET /api/works/:id/import-items/sample`           | action      |         |                      |
| `validate_import_items`             | `POST /api/works/:id/import-items/validate`        | action      |         |                      |
| `execute_import_items`              | `POST /api/works/:id/import-items`                 | create      |   yes   |                      |
| `get_work_config`                   | `GET /api/works/:id/config`                        | read        |         | WorkConfigCard       |
| `get_website_settings`              | `GET /api/works/:id/website-settings`              | read        |         |                      |
| `update_website_settings`           | `PUT /api/works/:id/website-settings`              | update      |         |                      |
| `get_work_count`                    | `GET /api/works/:id/count`                         | read        |         |                      |
| `get_work_categories_tags`          | `GET /api/works/:id/categories-tags`               | read        |         | TaxonomyList         |
| `get_work_history`                  | `GET /api/works/:id/history`                       | read        |         | HistoryTimeline      |
| `generate_work_details`             | `POST /api/works/generate-details`                 | action      |         |                      |
| `get_global_generator_form_schema`  | `GET /api/generator-form`                          | read        |         |                      |
| `get_generator_form_schema`         | `GET /api/works/:id/generator-form`                | read        |         |                      |
| `generate_items`                    | `POST /api/works/:id/generate`                     | action      |         |                      |
| `update_items`                      | `POST /api/works/:id/update`                       | action      |         |                      |
| `cancel_generation`                 | `POST /api/works/:id/cancel-generation`            | action      |   yes   |                      |
| `get_work_schedule`                 | `GET /api/works/:id/schedule`                      | read        |         |                      |
| `update_work_schedule`              | `PUT /api/works/:id/schedule`                      | update      |         |                      |
| `cancel_work_schedule`              | `DELETE /api/works/:id/schedule`                   | destructive |   yes   |                      |
| `run_scheduled_update`              | `POST /api/works/:id/schedule/run`                 | action      |         |                      |
| `submit_item`                       | `POST /api/works/:id/submit-item`                  | create      |         |                      |
| `remove_item`                       | `POST /api/works/:id/remove-item`                  | destructive |   yes   |                      |
| `update_item_metadata`              | `POST /api/works/:id/update-item`                  | update      |         |                      |
| `check_item_health`                 | `POST /api/works/:id/check-item-health`            | action      |         |                      |
| `get_source_validation_settings`    | `GET /api/works/:id/source-validation`             | read        |         |                      |
| `update_source_validation_settings` | `PUT /api/works/:id/source-validation`             | update      |         |                      |
| `extract_item_details`              | `POST /api/extract-item-details`                   | action      |         |                      |
| `bulk_capture_images`               | `POST /api/works/:id/bulk-capture-images`          | action      |         |                      |
| `update_domain_type`                | `PUT /api/works/:id/domain-type`                   | update      |         |                      |
| `regenerate_markdown`               | `POST /api/works/:id/regenerate-markdown`          | action      |         |                      |
| `update_readme`                     | `POST /api/works/:id/update-readme`                | action      |         |                      |
| `update_website_repository`         | `POST /api/works/:id/update-website`               | action      |         |                      |
| `switch_website_template`           | `POST /api/works/:id/switch-website-template`      | update      |   yes   |                      |
| `delete_work`                       | `POST /api/works/:id/delete`                       | destructive |   yes   |                      |
| `sync_work_data`                    | `POST /api/works/:id/sync-data`                    | action      |         |                      |
| `get_repository_visibility`         | `GET /api/works/:id/repositories/visibility`       | read        |         |                      |
| `update_repository_visibility`      | `PUT /api/works/:id/repositories/visibility`       | update      |   yes   |                      |
| `get_advanced_prompts`              | `GET /api/works/:id/advanced-prompts`              | read        |         |                      |
| `update_advanced_prompts`           | `PUT /api/works/:id/advanced-prompts`              | update      |         |                      |
| `analyze_repository`                | `POST /api/works/import/analyze`                   | action      |         |                      |
| `analyze_for_linking`               | `POST /api/works/import/analyze-for-linking`       | action      |         |                      |
| `import_work`                       | `POST /api/works/import`                           | create      |         |                      |
| `get_user_repositories`             | `GET /api/works/import/repositories`               | read        |         | RepositoriesList     |
| `create_category`                   | `POST /api/works/:id/categories`                   | create      |         |                      |
| `update_category`                   | `PUT /api/works/:id/categories/:categoryId`        | update      |         |                      |
| `delete_category`                   | `DELETE /api/works/:id/categories/:categoryId`     | destructive |   yes   |                      |
| `create_tag`                        | `POST /api/works/:id/tags`                         | create      |         |                      |
| `update_tag`                        | `PUT /api/works/:id/tags/:tagId`                   | update      |         |                      |
| `delete_tag`                        | `DELETE /api/works/:id/tags/:tagId`                | destructive |   yes   |                      |
| `create_collection`                 | `POST /api/works/:id/collections`                  | create      |         |                      |
| `update_collection`                 | `PUT /api/works/:id/collections/:collectionId`     | update      |         |                      |
| `delete_collection`                 | `DELETE /api/works/:id/collections/:collectionId`  | destructive |   yes   |                      |
| `process_community_prs`             | `POST /api/works/:id/process-community-prs`        | action      |         |                      |
| `list_comparisons`                  | `GET /api/works/:id/comparisons`                   | read        |         | ComparisonsList      |
| `get_remaining_comparison_count`    | `GET /api/works/:id/comparisons/remaining-count`   | read        |         |                      |
| `get_comparison_generation_status`  | `GET /api/works/:id/comparisons/generation-status` | read        |         |                      |
| `get_comparison`                    | `GET /api/works/:id/comparisons/:slug`             | read        |         | ComparisonDetailCard |
| `generate_next_comparison`          | `POST /api/works/:id/comparisons/generate`         | action      |         |                      |
| `generate_manual_comparison`        | `POST /api/works/:id/comparisons/generate-manual`  | action      |         |                      |
| `delete_comparison`                 | `DELETE /api/works/:id/comparisons/:slug`          | destructive |   yes   |                      |

</details>

<details><summary><b>works-items-taxonomy</b> - 28 tools</summary>

| Tool                                | Method / Path                                       | Kind        | Confirm | Canvas         |
| ----------------------------------- | --------------------------------------------------- | ----------- | :-----: | -------------- |
| `list_works`                        | `GET /api/works`                                    | read        |         | WorkListTable  |
| `get_work_stats`                    | `GET /api/works/stats`                              | read        |         | WorkStatsCard  |
| `get_work`                          | `GET /api/works/{id}`                               | read        |         | WorkDetailCard |
| `list_work_items`                   | `GET /api/works/{id}/items`                         | read        |         | ItemListTable  |
| `get_work_config`                   | `GET /api/works/{id}/config`                        | read        |         | WorkConfigCard |
| `get_work_categories_tags`          | `GET /api/works/{id}/categories-tags`               | read        |         | TaxonomyCard   |
| `get_export_items_settings`         | `GET /api/works/{id}/export-items/settings`         | read        |         |                |
| `export_work_items`                 | `GET /api/works/{id}/export-items`                  | action      |         |                |
| `get_import_items_settings`         | `GET /api/works/{id}/import-items/settings`         | read        |         |                |
| `get_import_items_sample`           | `GET /api/works/{id}/import-items/sample`           | action      |         |                |
| `validate_import_items`             | `POST /api/works/{id}/import-items/validate`        | action      |         |                |
| `execute_import_items`              | `POST /api/works/{id}/import-items`                 | create      |         |                |
| `extract_item_details`              | `POST /api/extract-item-details`                    | action      |         |                |
| `submit_item`                       | `POST /api/works/{id}/submit-item`                  | create      |         |                |
| `remove_item`                       | `POST /api/works/{id}/remove-item`                  | destructive |   yes   |                |
| `update_item`                       | `POST /api/works/{id}/update-item`                  | update      |         |                |
| `check_item_health`                 | `POST /api/works/{id}/check-item-health`            | action      |         |                |
| `get_source_validation_settings`    | `GET /api/works/{id}/source-validation`             | read        |         |                |
| `update_source_validation_settings` | `PUT /api/works/{id}/source-validation`             | update      |         |                |
| `create_category`                   | `POST /api/works/{id}/categories`                   | create      |         |                |
| `update_category`                   | `PUT /api/works/{id}/categories/{categoryId}`       | update      |         |                |
| `delete_category`                   | `DELETE /api/works/{id}/categories/{categoryId}`    | destructive |   yes   |                |
| `create_tag`                        | `POST /api/works/{id}/tags`                         | create      |         |                |
| `update_tag`                        | `PUT /api/works/{id}/tags/{tagId}`                  | update      |         |                |
| `delete_tag`                        | `DELETE /api/works/{id}/tags/{tagId}`               | destructive |   yes   |                |
| `create_collection`                 | `POST /api/works/{id}/collections`                  | create      |         |                |
| `update_collection`                 | `PUT /api/works/{id}/collections/{collectionId}`    | update      |         |                |
| `delete_collection`                 | `DELETE /api/works/{id}/collections/{collectionId}` | destructive |   yes   |                |

</details>

<details><summary><b>generation-comparisons-schedule</b> - 18 tools</summary>

| Tool                               | Method / Path                                       | Kind        | Confirm | Canvas                 |
| ---------------------------------- | --------------------------------------------------- | ----------- | :-----: | ---------------------- |
| `generate_items`                   | `POST /api/works/{id}/generate`                     | action      |         | GenerationProgressCard |
| `update_items`                     | `POST /api/works/{id}/update`                       | action      |         | GenerationProgressCard |
| `cancel_generation`                | `POST /api/works/{id}/cancel-generation`            | action      |         |                        |
| `get_schedule`                     | `GET /api/works/{id}/schedule`                      | read        |         | ScheduleDetailCard     |
| `update_schedule`                  | `PUT /api/works/{id}/schedule`                      | update      |         | ScheduleDetailCard     |
| `delete_schedule`                  | `DELETE /api/works/{id}/schedule`                   | destructive |   yes   |                        |
| `run_scheduled_update`             | `POST /api/works/{id}/schedule/run`                 | action      |         |                        |
| `list_comparisons`                 | `GET /api/works/{id}/comparisons`                   | read        |         | ComparisonListTable    |
| `get_comparison`                   | `GET /api/works/{id}/comparisons/{slug}`            | read        |         | ComparisonDetailCard   |
| `generate_next_comparison`         | `POST /api/works/{id}/comparisons/generate`         | action      |         | GenerationProgressCard |
| `generate_manual_comparison`       | `POST /api/works/{id}/comparisons/generate-manual`  | action      |         | GenerationProgressCard |
| `delete_comparison`                | `DELETE /api/works/{id}/comparisons/{slug}`         | destructive |   yes   |                        |
| `get_remaining_comparison_count`   | `GET /api/works/{id}/comparisons/remaining-count`   | read        |         |                        |
| `get_comparison_generation_status` | `GET /api/works/{id}/comparisons/generation-status` | read        |         | GenerationProgressCard |
| `update_website`                   | `POST /api/works/{id}/update-website`               | action      |         |                        |
| `regenerate_markdown`              | `POST /api/works/{id}/regenerate-markdown`          | action      |         |                        |
| `generate_work_details`            | `POST /api/works/generate-details`                  | action      |         |                        |
| `get_generator_form`               | `GET /api/works/{id}/generator-form`                | read        |         |                        |

</details>

<details><summary><b>website-deploy-git</b> - 33 tools</summary>

| Tool                              | Method / Path                                                                           | Kind        | Confirm | Canvas                     |
| --------------------------------- | --------------------------------------------------------------------------------------- | ----------- | :-----: | -------------------------- |
| `list_deployment_providers`       | `GET /api/deploy/providers`                                                             | read        |         |                            |
| `check_provider_configuration`    | `GET /api/deploy/providers/:providerId/configured`                                      | read        |         |                            |
| `deploy_work`                     | `POST /api/deploy/works/:id`                                                            | action      |         | DeploymentStatusCard       |
| `validate_deployment_token`       | `POST /api/deploy/validate-token`                                                       | read        |         |                            |
| `get_deployment_teams`            | `POST /api/deploy/teams`                                                                | read        |         |                            |
| `get_deployment_teams_for_work`   | `POST /api/deploy/works/:id/teams`                                                      | read        |         |                            |
| `check_deployment_capability`     | `POST /api/deploy/works/:id/check`                                                      | read        |         |                            |
| `lookup_existing_deployment`      | `POST /api/deploy/works/:id/lookup`                                                     | read        |         |                            |
| `list_work_domains`               | `GET /api/deploy/works/:id/domains`                                                     | read        |         | DomainListTable            |
| `add_domain`                      | `POST /api/deploy/works/:id/domains`                                                    | create      |         |                            |
| `remove_domain`                   | `DELETE /api/deploy/works/:id/domains/:domain`                                          | destructive |   yes   |                            |
| `verify_domain`                   | `POST /api/deploy/works/:id/domains/:domain/verify`                                     | action      |         |                            |
| `list_work_deployments`           | `GET /api/deploy/works/:id/deployments`                                                 | read        |         | DeploymentHistoryTable     |
| `rollback_deployment`             | `POST /api/deploy/works/:id/rollback`                                                   | action      |   yes   |                            |
| `list_git_providers`              | `GET /api/git-providers`                                                                | read        |         |                            |
| `check_git_provider_connection`   | `GET /api/git-providers/:providerId/connection`                                         | read        |         |                            |
| `get_git_organizations`           | `GET /api/git-providers/:providerId/organizations`                                      | read        |         |                            |
| `get_git_repositories`            | `GET /api/git-providers/:providerId/repositories`                                       | read        |         | RepositoryListTable        |
| `get_git_provider_user`           | `GET /api/git-providers/:providerId/user`                                               | read        |         |                            |
| `get_github_app_setup`            | `GET /api/github-app/setup`                                                             | read        |         |                            |
| `list_github_app_installations`   | `GET /api/github-app/installations`                                                     | read        |         | GitHubAppInstallationsList |
| `sync_github_app_installation`    | `POST /api/github-app/installations/:installationId/sync`                               | action      |         |                            |
| `onboard_github_app_repository`   | `POST /api/github-app/installations/:installationId/repositories/:repositoryId/onboard` | action      |         |                            |
| `list_oauth_providers`            | `GET /api/oauth/providers`                                                              | read        |         |                            |
| `check_oauth_provider_connection` | `GET /api/oauth/:providerId/connection`                                                 | read        |         |                            |
| `get_oauth_connect_url`           | `GET /api/oauth/:providerId/connect/url`                                                | read        |         |                            |
| `get_oauth_provider_user`         | `GET /api/oauth/:providerId/user`                                                       | read        |         |                            |
| `disconnect_oauth_provider`       | `DELETE /api/oauth/:providerId`                                                         | destructive |   yes   |                            |
| `get_oauth_read_packages_url`     | `GET /api/oauth/:providerId/read-packages/connect/url`                                  | read        |         |                            |
| `get_website_settings`            | `GET /api/works/:id/website-settings`                                                   | read        |         | WebsiteSettingsCard        |
| `update_website_settings`         | `PUT /api/works/:id/website-settings`                                                   | update      |         |                            |
| `switch_website_template`         | `POST /api/works/:id/switch-website-template`                                           | action      |   yes   |                            |
| `get_oauth_auth_url`              | `GET /api/oauth/:providerId/url`                                                        | read        |         |                            |

</details>

<details><summary><b>agents</b> - 29 tools</summary>

| Tool                              | Method / Path                                      | Kind        | Confirm | Canvas               |
| --------------------------------- | -------------------------------------------------- | ----------- | :-----: | -------------------- |
| `list_agents`                     | `GET /api/agents`                                  | read        |         | AgentListTable       |
| `create_agent`                    | `POST /api/agents`                                 | create      |         | AgentDetailCard      |
| `get_agent`                       | `GET /api/agents/:id`                              | read        |         | AgentDetailCard      |
| `update_agent`                    | `PATCH /api/agents/:id`                            | update      |         | AgentDetailCard      |
| `delete_agent`                    | `DELETE /api/agents/:id`                           | destructive |   yes   |                      |
| `pause_agent`                     | `POST /api/agents/:id/pause`                       | action      |         | AgentDetailCard      |
| `resume_agent`                    | `POST /api/agents/:id/resume`                      | action      |         | AgentDetailCard      |
| `read_agent_file`                 | `GET /api/agents/:id/files/:name`                  | read        |         | CodeEditor           |
| `write_agent_file`                | `PUT /api/agents/:id/files/:name`                  | update      |         | CodeEditor           |
| `export_agent`                    | `GET /api/agents/:id/export`                       | read        |         |                      |
| `import_agent`                    | `POST /api/agents/import`                          | create      |         | AgentDetailCard      |
| `run_agent_now`                   | `POST /api/agents/:id/run-now`                     | action      |         |                      |
| `list_agent_runs`                 | `GET /api/agents/:id/runs`                         | read        |         | AgentRunHistoryTable |
| `cancel_agent_run`                | `POST /api/agents/:id/runs/:runId/cancel`          | destructive |   yes   |                      |
| `list_agent_skills`               | `GET /api/agents/:id/skills`                       | read        |         | SkillBindingTable    |
| `get_agent_budget`                | `GET /api/agents/:id/budget`                       | read        |         | BudgetCard           |
| `assign_task_to_agent`            | `POST /api/agents/:id/assign-task`                 | action      |         |                      |
| `list_agent_attachments`          | `GET /api/agents/:id/attachments`                  | read        |         | AttachmentList       |
| `add_agent_attachment`            | `POST /api/agents/:id/attachments`                 | create      |         |                      |
| `remove_agent_attachment`         | `DELETE /api/agents/:id/attachments/:attachmentId` | destructive |   yes   |                      |
| `list_agent_templates`            | `GET /api/agent-templates`                         | read        |         | TemplateGallery      |
| `check_agent_memory_availability` | `GET /api/agent-memory/check-availability`         | read        |         |                      |
| `open_memory_session`             | `POST /api/agent-memory/sessions`                  | create      |         |                      |
| `close_memory_session`            | `POST /api/agent-memory/sessions/:sessionId/close` | action      |         |                      |
| `list_memory_sessions`            | `GET /api/agent-memory/sessions`                   | read        |         | MemorySessionTable   |
| `save_memory`                     | `POST /api/agent-memory/save`                      | create      |         |                      |
| `search_memory`                   | `POST /api/agent-memory/search`                    | read        |         | MemorySearchResults  |
| `build_memory_context`            | `POST /api/agent-memory/context`                   | read        |         |                      |
| `delete_memory_entry`             | `DELETE /api/agent-memory/entries/:entryId`        | destructive |   yes   |                      |

</details>

<details><summary><b>tasks</b> - 22 tools</summary>

| Tool                     | Method / Path                                     | Kind        | Confirm | Canvas             |
| ------------------------ | ------------------------------------------------- | ----------- | :-----: | ------------------ |
| `list_tasks`             | `GET /api/tasks`                                  | read        |         | TaskListTable      |
| `create_task`            | `POST /api/tasks`                                 | create      |         | TaskDetailCard     |
| `get_task`               | `GET /api/tasks/:id`                              | read        |         | TaskDetailCard     |
| `update_task`            | `PATCH /api/tasks/:id`                            | update      |         | TaskDetailCard     |
| `delete_task`            | `DELETE /api/tasks/:id`                           | destructive |   yes   |                    |
| `set_task_recurring`     | `POST /api/tasks/:id/recurring`                   | action      |         | TaskDetailCard     |
| `clear_task_recurring`   | `DELETE /api/tasks/:id/recurring`                 | destructive |         |                    |
| `transition_task`        | `POST /api/tasks/:id/transition`                  | action      |         | TaskDetailCard     |
| `add_task_assignee`      | `POST /api/tasks/:id/assignees`                   | create      |         |                    |
| `remove_task_assignee`   | `DELETE /api/tasks/:id/assignees/:assigneeId`     | destructive |         |                    |
| `add_task_reviewer`      | `POST /api/tasks/:id/reviewers`                   | create      |         |                    |
| `add_task_approver`      | `POST /api/tasks/:id/approvers`                   | create      |         |                    |
| `add_task_blocker`       | `POST /api/tasks/:id/blocks`                      | create      |         |                    |
| `remove_task_blocker`    | `DELETE /api/tasks/:id/blocks/:blockId`           | destructive |         |                    |
| `list_task_attachments`  | `GET /api/tasks/:id/attachments`                  | read        |         | AttachmentListCard |
| `add_task_attachment`    | `POST /api/tasks/:id/attachments`                 | create      |         |                    |
| `remove_task_attachment` | `DELETE /api/tasks/:id/attachments/:attachmentId` | destructive |         |                    |
| `add_task_relation`      | `POST /api/tasks/:id/relations`                   | create      |         |                    |
| `list_task_chat`         | `GET /api/tasks/:id/chat`                         | read        |         | TaskChatThread     |
| `post_task_chat`         | `POST /api/tasks/:id/chat`                        | create      |         |                    |
| `edit_task_chat_message` | `PATCH /api/task-chat-messages/:id`               | update      |         |                    |
| `get_task_spend`         | `GET /api/tasks/:id/spend`                        | read        |         | TaskSpendChart     |

</details>

<details><summary><b>missions-ideas-workagent</b> - 37 tools</summary>

| Tool                                | Method / Path                                                 | Kind        | Confirm | Canvas                  |
| ----------------------------------- | ------------------------------------------------------------- | ----------- | :-----: | ----------------------- |
| `list_missions`                     | `GET /api/me/missions`                                        | read        |         | MissionListTable        |
| `create_mission`                    | `POST /api/me/missions`                                       | create      |         | MissionDetailCard       |
| `get_mission`                       | `GET /api/me/missions/:id`                                    | read        |         | MissionDetailCard       |
| `get_mission_budget`                | `GET /api/me/missions/:id/budget`                             | read        |         | BudgetStatusCard        |
| `update_mission`                    | `PATCH /api/me/missions/:id`                                  | update      |         | MissionDetailCard       |
| `delete_mission`                    | `DELETE /api/me/missions/:id`                                 | destructive |   yes   |                         |
| `pause_mission`                     | `POST /api/me/missions/:id/pause`                             | action      |         | MissionDetailCard       |
| `resume_mission`                    | `POST /api/me/missions/:id/resume`                            | action      |         | MissionDetailCard       |
| `complete_mission`                  | `POST /api/me/missions/:id/complete`                          | action      |         | MissionDetailCard       |
| `clone_mission`                     | `POST /api/me/missions/:id/clone`                             | create      |         | MissionDetailCard       |
| `run_mission_now`                   | `POST /api/me/missions/:id/run-now`                           | action      |         |                         |
| `list_mission_attachments`          | `GET /api/me/missions/:id/attachments`                        | read        |         | AttachmentListCard      |
| `add_mission_attachment`            | `POST /api/me/missions/:id/attachments`                       | create      |         | AttachmentListCard      |
| `remove_mission_attachment`         | `DELETE /api/me/missions/:id/attachments/:attachmentId`       | destructive |         | AttachmentListCard      |
| `create_work_proposal`              | `POST /api/me/work-proposals`                                 | create      |         | WorkProposalDetailCard  |
| `list_work_proposals`               | `GET /api/me/work-proposals`                                  | read        |         | WorkProposalListTable   |
| `get_work_proposals_refresh_status` | `GET /api/me/work-proposals/status`                           | read        |         |                         |
| `refresh_work_proposals`            | `POST /api/me/work-proposals/refresh`                         | action      |         |                         |
| `get_work_proposals_preferences`    | `GET /api/me/work-proposals/preferences`                      | read        |         |                         |
| `update_work_proposals_preferences` | `PUT /api/me/work-proposals/preferences`                      | update      |         |                         |
| `get_work_proposal`                 | `GET /api/me/work-proposals/:id`                              | read        |         | WorkProposalDetailCard  |
| `get_work_proposal_budget`          | `GET /api/me/work-proposals/:id/budget`                       | read        |         | BudgetStatusCard        |
| `dismiss_work_proposal`             | `PATCH /api/me/work-proposals/:id/dismiss`                    | action      |         | WorkProposalDetailCard  |
| `build_work_proposal`               | `POST /api/me/work-proposals/:id/build`                       | action      |         | WorkProposalDetailCard  |
| `retry_work_proposal_build`         | `POST /api/me/work-proposals/:id/retry`                       | action      |         | WorkProposalDetailCard  |
| `rebuild_work_proposal`             | `POST /api/me/work-proposals/:id/rebuild`                     | action      |         | WorkProposalDetailCard  |
| `accept_work_proposal`              | `POST /api/me/work-proposals/:id/accept`                      | action      |         | WorkProposalDetailCard  |
| `list_work_proposal_attachments`    | `GET /api/me/work-proposals/:id/attachments`                  | read        |         | AttachmentListCard      |
| `add_work_proposal_attachment`      | `POST /api/me/work-proposals/:id/attachments`                 | create      |         | AttachmentListCard      |
| `remove_work_proposal_attachment`   | `DELETE /api/me/work-proposals/:id/attachments/:attachmentId` | destructive |         | AttachmentListCard      |
| `get_work_agent_preferences`        | `GET /api/me/work-agent/preferences`                          | read        |         |                         |
| `update_work_agent_preferences`     | `PUT /api/me/work-agent/preferences`                          | update      |         |                         |
| `list_work_agent_goals`             | `GET /api/me/work-agent/goals`                                | read        |         | WorkAgentGoalListTable  |
| `create_work_agent_goal`            | `POST /api/me/work-agent/goals`                               | create      |         | WorkAgentGoalDetailCard |
| `cancel_work_agent_goal`            | `PATCH /api/me/work-agent/goals/:id/cancel`                   | destructive |   yes   | WorkAgentGoalDetailCard |
| `get_work_agent_active_run`         | `GET /api/me/work-agent/runs/active`                          | read        |         | WorkAgentRunCard        |
| `list_work_agent_run_logs`          | `GET /api/me/work-agent/runs/:id/logs`                        | read        |         | WorkAgentRunLogsCard    |

</details>

<details><summary><b>plugins-integrations</b> - 23 tools</summary>

| Tool                                | Method / Path                                            | Kind        | Confirm | Canvas                           |
| ----------------------------------- | -------------------------------------------------------- | ----------- | :-----: | -------------------------------- |
| `list_plugins`                      | `GET /api/plugins`                                       | read        |         | PluginListCard                   |
| `get_plugins_settings_menu`         | `GET /api/plugins/settings-menu`                         | read        |         | SettingsMenuCard                 |
| `list_plugin_models`                | `GET /api/plugins/{pluginId}/models`                     | read        |         | ModelListCard                    |
| `get_plugin_connection_status`      | `GET /api/plugins/{pluginId}/connection-status`          | read        |         | ConnectionStatusCard             |
| `get_plugin`                        | `GET /api/plugins/{pluginId}`                            | read        |         | PluginDetailCard                 |
| `enable_plugin`                     | `POST /api/plugins/{pluginId}/enable`                    | create      |         | PluginDetailCard                 |
| `disable_plugin`                    | `POST /api/plugins/{pluginId}/disable`                   | destructive |   yes   | PluginDetailCard                 |
| `update_plugin_settings`            | `PATCH /api/plugins/{pluginId}/settings`                 | update      |         | PluginDetailCard                 |
| `set_global_pipeline_default`       | `POST /api/plugins/pipeline-default`                     | update      |         |                                  |
| `validate_plugin_connection`        | `POST /api/plugins/{pluginId}/validate-connection`       | action      |         | ConnectionStatusCard             |
| `list_work_plugins`                 | `GET /api/works/{workId}/plugins`                        | read        |         | WorkPluginListCard               |
| `enable_work_plugin`                | `POST /api/works/{workId}/plugins/{pluginId}/enable`     | create      |         | WorkPluginDetailCard             |
| `disable_work_plugin`               | `POST /api/works/{workId}/plugins/{pluginId}/disable`    | destructive |   yes   | WorkPluginDetailCard             |
| `update_work_plugin_settings`       | `PATCH /api/works/{workId}/plugins/{pluginId}/settings`  | update      |         | WorkPluginDetailCard             |
| `set_work_plugin_active_capability` | `POST /api/works/{workId}/plugins/{pluginId}/capability` | update      |         | WorkPluginDetailCard             |
| `list_composio_toolkits`            | `GET /api/plugins/composio/toolkits`                     | read        |         | ComposioToolkitListCard          |
| `list_composio_connected_accounts`  | `GET /api/plugins/composio/connected-accounts`           | read        |         | ComposioConnectedAccountListCard |
| `initiate_composio_connection`      | `POST /api/plugins/composio/connect`                     | create      |         |                                  |
| `list_composio_triggers`            | `GET /api/plugins/composio/triggers`                     | read        |         | ComposioTriggerListCard          |
| `create_composio_trigger`           | `POST /api/plugins/composio/triggers`                    | create      |         | ComposioTriggerDetailCard        |
| `delete_composio_trigger`           | `DELETE /api/plugins/composio/triggers/{id}`             | destructive |   yes   |                                  |
| `get_device_auth_status`            | `GET /api/device-auth/{pluginId}/status`                 | read        |         | DeviceAuthStatusCard             |
| `start_device_auth`                 | `POST /api/device-auth/{pluginId}/start`                 | action      |         | DeviceAuthStatusCard             |

</details>

<details><summary><b>skills</b> - 11 tools</summary>

| Tool                         | Method / Path                    | Kind        | Confirm | Canvas             |
| ---------------------------- | -------------------------------- | ----------- | :-----: | ------------------ |
| `list_skill_catalog`         | `GET /api/skills/catalog`        | read        |         | SkillCatalogTable  |
| `get_skill_catalog_entry`    | `GET /api/skills/catalog/:slug`  | read        |         | SkillDetailCard    |
| `list_skills`                | `GET /api/skills`                | read        |         | SkillListTable     |
| `get_skill`                  | `GET /api/skills/:id`            | read        |         | SkillDetailCard    |
| `create_skill`               | `POST /api/skills`               | create      |         | SkillForm          |
| `update_skill`               | `PATCH /api/skills/:id`          | update      |         | SkillForm          |
| `delete_skill`               | `DELETE /api/skills/:id`         | destructive |   yes   |                    |
| `install_skill_from_catalog` | `POST /api/skills/install`       | create      |         |                    |
| `list_skill_bindings`        | `GET /api/skills/:id/bindings`   | read        |         | SkillBindingsTable |
| `create_skill_binding`       | `POST /api/skills/:id/bindings`  | create      |         |                    |
| `delete_skill_binding`       | `DELETE /api/skill-bindings/:id` | destructive |   yes   |                    |

</details>

<details><summary><b>knowledge-base</b> - 23 tools</summary>

| Tool                            | Method / Path                                               | Kind        | Confirm | Canvas                  |
| ------------------------------- | ----------------------------------------------------------- | ----------- | :-----: | ----------------------- |
| `list_kb_documents`             | `GET /api/works/:id/kb/documents`                           | read        |         | KbDocumentList          |
| `create_kb_document`            | `POST /api/works/:id/kb/documents`                          | create      |         | KbDocumentForm          |
| `get_kb_document`               | `GET /api/works/:id/kb/documents/:docIdOrPath`              | read        |         | KbDocumentDetail        |
| `update_kb_document`            | `PATCH /api/works/:id/kb/documents/:docId`                  | update      |         | KbDocumentForm          |
| `delete_kb_document`            | `DELETE /api/works/:id/kb/documents/:docId`                 | destructive |   yes   |                         |
| `lock_kb_document`              | `POST /api/works/:id/kb/documents/:docId/lock`              | action      |         | KbDocumentDetail        |
| `unlock_kb_document`            | `POST /api/works/:id/kb/documents/:docId/unlock`            | action      |         | KbDocumentDetail        |
| `restore_kb_document`           | `POST /api/works/:id/kb/documents/:docId/restore`           | action      |   yes   |                         |
| `get_kb_document_history`       | `GET /api/works/:id/kb/documents/:docId/history`            | read        |         | KbDocumentHistory       |
| `list_kb_citations`             | `GET /api/works/:id/kb/documents/:docId/citations`          | read        |         | KbCitationList          |
| `list_kb_tags`                  | `GET /api/works/:id/kb/tags`                                | read        |         | KbTagList               |
| `create_kb_tag`                 | `POST /api/works/:id/kb/tags`                               | create      |         | KbTagForm               |
| `update_kb_tag`                 | `PATCH /api/works/:id/kb/tags/:tagId`                       | update      |         | KbTagForm               |
| `delete_kb_tag`                 | `DELETE /api/works/:id/kb/tags/:tagId`                      | destructive |   yes   |                         |
| `create_kb_upload`              | `POST /api/works/:id/kb/uploads`                            | create      |         | KbUploadForm            |
| `list_kb_uploads`               | `GET /api/works/:id/kb/uploads`                             | read        |         | KbUploadList            |
| `get_kb_upload`                 | `GET /api/works/:id/kb/uploads/:uploadId`                   | read        |         | KbUploadDetail          |
| `download_kb_upload`            | `GET /api/works/:id/kb/uploads/:uploadId/download`          | read        |         |                         |
| `retry_kb_upload_extraction`    | `POST /api/works/:id/kb/uploads/:uploadId/retry-extraction` | action      |         | KbUploadDetail          |
| `list_org_kb_documents`         | `GET /api/organizations/:orgId/kb/documents`                | read        |         | OrgKbDocumentList       |
| `create_org_kb_document`        | `POST /api/organizations/:orgId/kb/documents`               | create      |         | OrgKbDocumentForm       |
| `resolve_inheritable_documents` | `GET /api/works/:id/kb/inheritable`                         | read        |         | InheritableDocumentList |
| `get_inherited_document`        | `GET /api/works/:id/kb/inheritable/*idOrPath`               | read        |         | KbDocumentDetail        |

</details>

<details><summary><b>orgs-tenants-members</b> - 17 tools</summary>

| Tool                                | Method / Path                                         | Kind        | Confirm | Canvas                 |
| ----------------------------------- | ----------------------------------------------------- | ----------- | :-----: | ---------------------- |
| `create_organization`               | `POST /api/organizations`                             | create      |         | OrganizationDetailCard |
| `register_company`                  | `POST /api/organizations/register-company`            | create      |         | OrganizationDetailCard |
| `list_organizations`                | `GET /api/organizations`                              | read        |         | OrganizationListTable  |
| `check_organization_slug`           | `GET /api/organizations/check-slug`                   | read        |         |                        |
| `get_organization_by_slug`          | `GET /api/organizations/:slug`                        | read        |         | OrganizationDetailCard |
| `update_organization`               | `PATCH /api/organizations/:id`                        | update      |         |                        |
| `upgrade_organization_from_account` | `POST /api/organizations/:id/upgrade-from-account`    | action      |         |                        |
| `list_work_members`                 | `GET /api/works/:workId/members`                      | read        |         | MemberListTable        |
| `add_work_member`                   | `POST /api/works/:workId/members`                     | create      |         |                        |
| `get_work_member`                   | `GET /api/works/:workId/members/:memberId`            | read        |         | MemberDetailCard       |
| `update_work_member_role`           | `PUT /api/works/:workId/members/:memberId`            | update      |         |                        |
| `remove_work_member`                | `DELETE /api/works/:workId/members/:memberId`         | destructive |   yes   |                        |
| `leave_work`                        | `POST /api/works/:workId/members/leave`               | destructive |   yes   |                        |
| `create_work_invitation`            | `POST /api/works/:workId/invitations`                 | create      |         | InvitationDetailCard   |
| `list_work_invitations`             | `GET /api/works/:workId/invitations`                  | read        |         | InvitationListTable    |
| `revoke_work_invitation`            | `DELETE /api/works/:workId/invitations/:invitationId` | destructive |   yes   |                        |
| `check_username_availability`       | `GET /api/users/check-username`                       | read        |         |                        |

</details>

<details><summary><b>auth-account-security</b> - 29 tools</summary>

| Tool                        | Method / Path                       | Kind        | Confirm | Canvas                |
| --------------------------- | ----------------------------------- | ----------- | :-----: | --------------------- |
| `get_auth_providers`        | `GET /api/auth/providers`           | read        |         | ProviderConfigCard    |
| `get_user_profile`          | `GET /api/auth/profile`             | read        |         | UserProfileCard       |
| `get_fresh_user_profile`    | `GET /api/auth/profile/fresh`       | read        |         | UserProfileCard       |
| `update_user_profile`       | `PUT /api/auth/profile`             | update      |         |                       |
| `update_password`           | `POST /api/auth/update-password`    | update      |   yes   |                       |
| `send_verification_email`   | `POST /api/auth/send-verification`  | action      |         |                       |
| `logout_current_session`    | `POST /api/auth/logout`             | action      |   yes   |                       |
| `logout_all_sessions`       | `POST /api/auth/logout-all`         | destructive |   yes   |                       |
| `create_api_key`            | `POST /api/auth/api-keys`           | create      |         | ApiKeyDetailCard      |
| `list_api_keys`             | `GET /api/auth/api-keys`            | read        |         | ApiKeyListTable       |
| `revoke_api_key`            | `DELETE /api/auth/api-keys/:id`     | destructive |   yes   |                       |
| `export_account_data`       | `GET /api/account/export`           | read        |         | ExportProgressCard    |
| `preview_account_import`    | `POST /api/account/import/preview`  | read        |         |                       |
| `apply_account_import`      | `POST /api/account/import/apply`    | action      |   yes   |                       |
| `get_sync_status`           | `GET /api/account/sync/status`      | read        |         | SyncStatusCard        |
| `configure_sync_repository` | `POST /api/account/sync/configure`  | action      |   yes   |                       |
| `push_to_github`            | `POST /api/account/sync/push`       | action      |   yes   |                       |
| `pull_from_github`          | `POST /api/account/sync/pull`       | action      |         |                       |
| `apply_github_pull`         | `POST /api/account/sync/pull/apply` | action      |   yes   |                       |
| `remove_sync_configuration` | `DELETE /api/account/sync`          | destructive |   yes   |                       |
| `get_onboarding_state`      | `GET /api/onboarding/state`         | read        |         |                       |
| `update_onboarding_state`   | `PATCH /api/onboarding/state`       | update      |         |                       |
| `mark_onboarding_completed` | `POST /api/onboarding/complete`     | action      |         |                       |
| `mark_onboarding_dismissed` | `POST /api/onboarding/dismiss`      | action      |         |                       |
| `get_onboarding_catalog`    | `GET /api/onboarding/catalog`       | read        |         | OnboardingCatalogCard |
| `preview_claim_invitation`  | `GET /api/claim/preview`            | read        |         |                       |
| `accept_claim_invitation`   | `POST /api/claim/accept`            | action      |   yes   |                       |
| `get_subscription_plan`     | `GET /api/subscriptions/plan`       | read        |         | SubscriptionPlanCard  |
| `update_subscription_plan`  | `POST /api/subscriptions/plan`      | update      |   yes   |                       |

</details>

<details><summary><b>notifications</b> - 17 tools</summary>

| Tool                             | Method / Path                                          | Kind        | Confirm | Canvas                        |
| -------------------------------- | ------------------------------------------------------ | ----------- | :-----: | ----------------------------- |
| `list_notifications`             | `GET /api/notifications`                               | read        |         | NotificationsList             |
| `get_unread_notification_count`  | `GET /api/notifications/unread-count`                  | read        |         | NotificationUnreadBadge       |
| `get_persistent_notifications`   | `GET /api/notifications/persistent`                    | read        |         | PersistentNotificationsBanner |
| `mark_notification_as_read`      | `POST /api/notifications/:id/read`                     | update      |         |                               |
| `mark_all_notifications_as_read` | `POST /api/notifications/read-all`                     | update      |         |                               |
| `dismiss_notification`           | `POST /api/notifications/:id/dismiss`                  | action      |         |                               |
| `list_notification_event_types`  | `GET /api/notifications/event-types`                   | read        |         | EventTypesList                |
| `get_notification_preferences`   | `GET /api/notifications/preferences`                   | read        |         | NotificationPreferencesPanel  |
| `set_event_subscription`         | `PUT /api/notifications/preferences/event/:eventKey`   | update      |         |                               |
| `set_quiet_hours`                | `PUT /api/notifications/preferences/quiet-hours`       | update      |         |                               |
| `mute_notification_category`     | `POST /api/notifications/preferences/mute`             | action      |         |                               |
| `unmute_notification_category`   | `DELETE /api/notifications/preferences/mute/:category` | update      |         |                               |
| `list_notification_channels`     | `GET /api/notification-channels`                       | read        |         | NotificationChannelsList      |
| `create_notification_channel`    | `POST /api/notification-channels`                      | create      |         | NotificationChannelForm       |
| `update_notification_channel`    | `PATCH /api/notification-channels/:id`                 | update      |         | NotificationChannelForm       |
| `delete_notification_channel`    | `DELETE /api/notification-channels/:id`                | destructive |   yes   |                               |
| `test_notification_channel`      | `POST /api/notification-channels/:id/test`             | action      |         |                               |

</details>

<details><summary><b>budgets-usage-billing</b> - 9 tools</summary>

| Tool                     | Method / Path                                   | Kind        | Confirm | Canvas                |
| ------------------------ | ----------------------------------------------- | ----------- | :-----: | --------------------- |
| `list_work_budgets`      | `GET /api/works/{workId}/budgets`               | read        |         | BudgetListTable       |
| `create_work_budget`     | `POST /api/works/{workId}/budgets`              | create      |         | BudgetDetailCard      |
| `update_work_budget`     | `PATCH /api/works/{workId}/budgets/{budgetId}`  | update      |         | BudgetDetailCard      |
| `delete_work_budget`     | `DELETE /api/works/{workId}/budgets/{budgetId}` | destructive |   yes   |                       |
| `get_work_usage_summary` | `GET /api/works/{workId}/usage/summary`         | read        |         | UsageSummaryCard      |
| `export_work_usage_csv`  | `GET /api/works/{workId}/usage/export`          | action      |         |                       |
| `get_work_usage_trend`   | `GET /api/works/{workId}/usage/trend`           | read        |         | UsageTrendChart       |
| `get_account_wide_usage` | `GET /api/me/usage/account-wide`                | read        |         | AccountWideBudgetCard |
| `get_admin_usage_report` | `GET /admin/usage`                              | read        |         | AdminUsageTable       |

</details>

<details><summary><b>email-comms</b> - 8 tools</summary>

| Tool                         | Method / Path                          | Kind        | Confirm | Canvas                 |
| ---------------------------- | -------------------------------------- | ----------- | :-----: | ---------------------- |
| `list_email_addresses`       | `GET /api/email/addresses`             | read        |         | EmailAddressListTable  |
| `create_email_address`       | `POST /api/email/addresses`            | create      |         | EmailAddressDetailCard |
| `update_email_address`       | `PATCH /api/email/addresses/:id`       | update      |         | EmailAddressDetailCard |
| `delete_email_address`       | `DELETE /api/email/addresses/:id`      | destructive |   yes   |                        |
| `trigger_email_verification` | `POST /api/email/addresses/:id/verify` | action      |         |                        |
| `list_email_messages`        | `GET /api/email/messages`              | read        |         | EmailMessageListTable  |
| `get_email_message`          | `GET /api/email/messages/:id`          | read        |         | EmailMessageDetailCard |
| `send_email_message`         | `POST /api/email/messages`             | create      |         |                        |

</details>

<details><summary><b>activity-webhooks-files-templates</b> - 46 tools</summary>

| Tool                               | Method / Path                                         | Kind        | Confirm | Canvas                      |
| ---------------------------------- | ----------------------------------------------------- | ----------- | :-----: | --------------------------- |
| `list_activities`                  | `GET /api/activity-log`                               | read        |         | ActivityLogTable            |
| `get_running_count`                | `GET /api/activity-log/running-count`                 | read        |         | ActivityBadge               |
| `get_activity_summary`             | `GET /api/activity-log/summary`                       | read        |         | ActivitySummaryCard         |
| `export_activity_log_csv`          | `GET /api/activity-log/export`                        | read        |         |                             |
| `get_activity`                     | `GET /api/activity-log/:id`                           | read        |         | ActivityDetailCard          |
| `list_webhooks`                    | `GET /api/webhooks`                                   | read        |         | WebhookSubscriptionList     |
| `list_webhook_deliveries`          | `GET /api/webhooks/deliveries`                        | read        |         | WebhookDeliveriesList       |
| `create_webhook`                   | `POST /api/webhooks`                                  | create      |         |                             |
| `update_webhook`                   | `PATCH /api/webhooks/:id`                             | update      |         |                             |
| `test_webhook`                     | `POST /api/webhooks/:id/test`                         | action      |         |                             |
| `rotate_webhook_secret`            | `POST /api/webhooks/:id/rotate-secret`                | action      |   yes   |                             |
| `redeliver_webhook`                | `POST /api/webhooks/deliveries/:deliveryId/redeliver` | action      |         |                             |
| `delete_webhook`                   | `DELETE /api/webhooks/:id`                            | destructive |   yes   |                             |
| `upload_image`                     | `POST /api/uploads`                                   | create      |         |                             |
| `upload_file`                      | `POST /api/uploads/file`                              | create      |         |                             |
| `upload_anonymous`                 | `POST /api/uploads/anonymous`                         | create      |         |                             |
| `upload_anonymous_file`            | `POST /api/uploads/anonymous/file`                    | create      |         |                             |
| `presign_upload`                   | `POST /api/uploads/presign`                           | action      |         |                             |
| `serve_upload`                     | `GET /api/uploads/:userId/:filename`                  | read        |         |                             |
| `list_templates`                   | `GET /api/templates`                                  | read        |         | TemplateList                |
| `add_custom_template`              | `POST /api/templates/custom`                          | create      |         |                             |
| `update_custom_template`           | `PUT /api/templates/custom/:templateId`               | update      |         |                             |
| `archive_custom_template`          | `POST /api/templates/custom/:templateId/archive`      | action      |   yes   |                             |
| `set_default_template`             | `PUT /api/templates/default`                          | update      |         |                             |
| `fork_template`                    | `POST /api/templates/fork`                            | action      |         |                             |
| `list_customization_providers`     | `GET /api/templates/customization-providers`          | read        |         |                             |
| `list_customization_ai_providers`  | `GET /api/templates/customization-ai-providers`       | read        |         |                             |
| `customize_template_from_base`     | `POST /api/templates/custom-from-base`                | action      |         |                             |
| `iterate_custom_template`          | `POST /api/templates/custom/:templateId/customize`    | action      |         |                             |
| `sync_custom_template_from_base`   | `POST /api/templates/custom/:templateId/sync-base`    | action      |         |                             |
| `get_customization`                | `GET /api/templates/customizations/:customizationId`  | read        |         | CustomizationDetailCard     |
| `list_customizations_for_template` | `GET /api/templates/:templateId/customizations`       | read        |         | CustomizationList           |
| `refresh_templates`                | `POST /api/templates/refresh`                         | action      |         |                             |
| `check_screenshot_availability`    | `GET /api/screenshot/check-availability`              | read        |         | ScreenshotAvailabilityCard  |
| `capture_screenshot`               | `POST /api/screenshot/capture`                        | action      |         |                             |
| `get_screenshot_url`               | `POST /api/screenshot/get-url`                        | action      |         |                             |
| `check_search_availability`        | `GET /api/search/check-availability`                  | read        |         | SearchAvailabilityCard      |
| `search_web`                       | `POST /api/search`                                    | action      |         | SearchResultsList           |
| `check_agent_memory_availability`  | `GET /api/agent-memory/check-availability`            | read        |         | AgentMemoryAvailabilityCard |
| `open_memory_session`              | `POST /api/agent-memory/sessions`                     | create      |         |                             |
| `close_memory_session`             | `POST /api/agent-memory/sessions/:sessionId/close`    | action      |         |                             |
| `list_memory_sessions`             | `GET /api/agent-memory/sessions`                      | read        |         | MemorySessionsList          |
| `save_memory`                      | `POST /api/agent-memory/save`                         | create      |         |                             |
| `search_memory`                    | `POST /api/agent-memory/search`                       | read        |         | MemorySearchResults         |
| `build_memory_context`             | `POST /api/agent-memory/context`                      | action      |         |                             |
| `delete_memory_entry`              | `DELETE /api/agent-memory/entries/:entryId`           | destructive |   yes   |                             |

</details>

### 5.2 Excluded endpoints (and why)

| Domain                            | Endpoint                                                    | Reason                                                                        |
| --------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| works-items-taxonomy              | `POST /api/works/{id}/items/bulk-delete`                    | bulk                                                                          |
| works-items-taxonomy              | `POST /api/works/{id}/items/bulk-update`                    | bulk                                                                          |
| works-items-taxonomy              | `POST /api/works/{id}/items/bulk-publish`                   | bulk                                                                          |
| works-items-taxonomy              | `POST /api/works/{id}/bulk-capture-images`                  | bulk                                                                          |
| website-deploy-git                | `POST /api/deploy/batch`                                    | bulk                                                                          |
| website-deploy-git                | `GET /api/github-app/callback`                              | OAuth callback redirect endpoint                                              |
| website-deploy-git                | `GET /api/oauth/:providerId/callback/plugins`               | OAuth callback redirect endpoint                                              |
| website-deploy-git                | `GET /api/oauth/:providerId/callback/plugins/read-packages` | OAuth callback redirect endpoint                                              |
| website-deploy-git                | `GET /api/oauth/:providerId/callback`                       | OAuth callback redirect endpoint                                              |
| plugins-integrations              | `POST /api/plugins/composio/webhook`                        | webhook handler - internal inbound endpoint                                   |
| auth-account-security             | `POST /api/auth/magic-link`                                 | auth-flow                                                                     |
| auth-account-security             | `GET /api/auth/validate-email-token`                        | auth-flow                                                                     |
| auth-account-security             | `GET /api/auth/validate-reset-token`                        | auth-flow                                                                     |
| auth-account-security             | `POST /api/onboarding/telemetry`                            | telemetry-beacon                                                              |
| email-comms                       | `GET /api/email/verify/:token`                              | public verification click-through endpoint (not a user-initiated chat action) |
| activity-webhooks-files-templates | `POST /api/uploads/image`                                   | duplicate endpoint                                                            |

## 6. Canvas component catalog

113 deduped components. `reuseExisting` points at a platform component to adapt rather than build fresh.

| Component                          | Kind   | Purpose                                                                                                            | Reuse                                                  |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `WorksList`                        | table  | Paginated list of works with search/filter (works-core, works-items-taxonomy WorkListTable).                       | ItemsList-style data table already exists in dashboard |
| `WorkDetailCard`                   | detail | Single work detail/settings panel with edit (works-core, works-items-taxonomy).                                    |                                                        |
| `WorkStatsCard`                    | stat   | Aggregated work metrics: total works, items, active websites.                                                      |                                                        |
| `WorkConfigCard`                   | detail | Work configuration and settings panel.                                                                             |                                                        |
| `ItemsList`                        | table  | List/manage work items with inline edit (works-core ItemsList, works-items-taxonomy ItemListTable).                | Existing dashboard ItemsList component                 |
| `TaxonomyList`                     | list   | Categories, tags, collections tree for a work (works-core TaxonomyList, works-items-taxonomy TaxonomyCard).        |                                                        |
| `HistoryTimeline`                  | list   | Timeline of generation/update history for a work.                                                                  |                                                        |
| `TemplatesList`                    | list   | Available website templates (works-core TemplatesList; activity domain TemplateList).                              |                                                        |
| `RepositoriesList`                 | table  | User/git repositories for import or linking (works-core RepositoriesList; website-deploy-git RepositoryListTable). |                                                        |
| `ComparisonsList`                  | table  | Generated comparisons with status (works-core ComparisonsList; generation domain ComparisonListTable).             |                                                        |
| `ComparisonDetailCard`             | detail | Single comparison result with side-by-side analysis.                                                               |                                                        |
| `GenerationProgressCard`           | stat   | Real-time progress for item/comparison/markdown generation.                                                        |                                                        |
| `ScheduleDetailCard`               | detail | Schedule config: cadence, enabled, billing mode, next/last run.                                                    |                                                        |
| `DeploymentStatusCard`             | stat   | Deployment status/progress/metadata for a single deploy.                                                           |                                                        |
| `DomainListTable`                  | table  | Custom domains with verification status and DNS records.                                                           |                                                        |
| `DeploymentHistoryTable`           | table  | Deployment history with branch/commit/timestamp/status and rollback.                                               |                                                        |
| `GitHubAppInstallationsList`       | list   | GitHub App installations with sync/onboard actions.                                                                |                                                        |
| `WebsiteSettingsCard`              | detail | Website config: template, domain settings, visibility.                                                             |                                                        |
| `AgentListTable`                   | table  | Agents filtered by scope/status/search.                                                                            | AgentCard exists for per-agent rendering               |
| `AgentDetailCard`                  | detail | Full agent profile, model, status, targets, heartbeat.                                                             | Existing AgentCard component                           |
| `CodeEditor`                       | form   | Edit agent definition files (SOUL.md/AGENTS.md/etc.) with concurrency-hash guard.                                  |                                                        |
| `AgentRunHistoryTable`             | table  | Agent run history with status/trigger/duration/error.                                                              |                                                        |
| `SkillBindingTable`                | table  | Active skill bindings with priority/target (agents SkillBindingTable; skills SkillBindingsTable).                  |                                                        |
| `BudgetCard`                       | stat   | Current-period spend rollup vs cap (agents BudgetCard; missions BudgetStatusCard).                                 | BudgetOverviewCard exists in dashboard                 |
| `AttachmentList`                   | list   | Entity attachments with remove actions (agents AttachmentList; tasks/missions AttachmentListCard).                 |                                                        |
| `TemplateGallery`                  | list   | Browse agent/skill/task templates from catalog.                                                                    |                                                        |
| `MemorySessionTable`               | table  | Agent-memory sessions (agents MemorySessionTable; activity MemorySessionsList).                                    |                                                        |
| `MemorySearchResults`              | list   | Memory search results with relevance/tags/metadata (agents + activity domains).                                    |                                                        |
| `TaskListTable`                    | table  | Filtered task list with status/priority/inline actions.                                                            |                                                        |
| `TaskDetailCard`                   | detail | Full task: assignees/reviewers/approvers/blockers/relations/attachments.                                           |                                                        |
| `TaskChatThread`                   | list   | Paginated task chat thread with mentions and edit.                                                                 |                                                        |
| `TaskSpendChart`                   | chart  | Per-task spend rollup over time with date filters.                                                                 | SpendTrendCard recharts component                      |
| `MissionListTable`                 | table  | Missions with status/schedule and quick actions.                                                                   |                                                        |
| `MissionDetailCard`                | detail | Full mission metadata, schedule, budget, lifecycle actions.                                                        |                                                        |
| `WorkProposalListTable`            | table  | Work proposals (ideas) filtered by status.                                                                         |                                                        |
| `WorkProposalDetailCard`           | detail | Proposal detail with build/retry/rebuild/accept actions.                                                           |                                                        |
| `WorkAgentGoalListTable`           | table  | Recent work-agent goals with cancel action.                                                                        |                                                        |
| `WorkAgentGoalDetailCard`          | detail | Work-agent goal detail with dry-run flag and cancel.                                                               |                                                        |
| `WorkAgentRunCard`                 | detail | Active work-agent run status with logs link.                                                                       |                                                        |
| `WorkAgentRunLogsCard`             | list   | Scrollable work-agent run logs with levels/timestamps.                                                             |                                                        |
| `PluginListCard`                   | table  | Available plugins with install status and categories.                                                              |                                                        |
| `PluginDetailCard`                 | detail | Single plugin details, settings, action controls.                                                                  |                                                        |
| `SettingsMenuCard`                 | list   | Installed plugins grouped by category for settings nav.                                                            |                                                        |
| `ModelListCard`                    | list   | Available AI models from a provider plugin.                                                                        |                                                        |
| `ConnectionStatusCard`             | detail | Plugin connection health and test results.                                                                         |                                                        |
| `WorkPluginListCard`               | table  | Plugins with work-specific config and active capabilities.                                                         |                                                        |
| `WorkPluginDetailCard`             | detail | Work-scoped plugin settings and capability assignment.                                                             |                                                        |
| `ComposioToolkitListCard`          | table  | Available Composio toolkits and metadata.                                                                          |                                                        |
| `ComposioConnectedAccountListCard` | table  | Composio connected accounts with status/actions.                                                                   |                                                        |
| `ComposioTriggerListCard`          | table  | Composio trigger subscriptions with delivery metrics.                                                              |                                                        |
| `ComposioTriggerDetailCard`        | detail | Single Composio trigger config and activity.                                                                       |                                                        |
| `DeviceAuthStatusCard`             | detail | Plugin device-auth flow status and user code.                                                                      |                                                        |
| `SkillCatalogTable`                | table  | Catalog skills with filtering/search/tags.                                                                         |                                                        |
| `SkillListTable`                   | table  | User's installed skills with owner type/actions.                                                                   |                                                        |
| `SkillDetailCard`                  | detail | Full skill metadata, instructions, frontmatter.                                                                    |                                                        |
| `SkillForm`                        | form   | Create/update custom skill (title, description, instructions).                                                     |                                                        |
| `KbDocumentList`                   | table  | KB documents filtered by class/status/tag/search (incl OrgKbDocumentList).                                         |                                                        |
| `KbDocumentDetail`                 | detail | KB document body, metadata, lock status, version history (incl inherited docs).                                    |                                                        |
| `KbDocumentForm`                   | form   | Create/update KB document (incl OrgKbDocumentForm).                                                                |                                                        |
| `KbDocumentHistory`                | list   | Git commit timeline for a KB doc with restore.                                                                     |                                                        |
| `KbCitationList`                   | list   | AI citations referencing a KB document.                                                                            |                                                        |
| `KbTagList`                        | list   | Per-work KB tags management.                                                                                       |                                                        |
| `KbTagForm`                        | form   | Create/update a KB tag.                                                                                            |                                                        |
| `KbUploadList`                     | table  | KB file uploads with extraction status.                                                                            |                                                        |
| `KbUploadDetail`                   | detail | Upload metadata, preview, extraction status, retry.                                                                |                                                        |
| `KbUploadForm`                     | form   | File upload form with metadata (title/class/tags).                                                                 |                                                        |
| `InheritableDocumentList`          | list   | Merged org + work-override inheritable KB documents.                                                               |                                                        |
| `OrganizationListTable`            | table  | User organizations with slug/name/status/actions.                                                                  |                                                        |
| `OrganizationDetailCard`           | detail | Single organization details, status, linked work.                                                                  |                                                        |
| `MemberListTable`                  | table  | Work members with role/status/actions.                                                                             |                                                        |
| `MemberDetailCard`                 | detail | Single work member profile, role, permissions.                                                                     |                                                        |
| `InvitationListTable`              | table  | Pending work invitations with revoke action.                                                                       |                                                        |
| `InvitationDetailCard`             | detail | Invitation claim URL, role, expiry for sharing.                                                                    |                                                        |
| `UserProfileCard`                  | detail | User profile with edit (name/avatar/bio/verification).                                                             |                                                        |
| `ApiKeyListTable`                  | table  | API keys with creation/expiration and revoke.                                                                      |                                                        |
| `ApiKeyDetailCard`                 | detail | Newly created API key secret (once) with copy/download.                                                            |                                                        |
| `ProviderConfigCard`               | detail | Enabled OAuth providers and magic-link status.                                                                     |                                                        |
| `SyncStatusCard`                   | detail | GitHub account-sync status, repo, last push/pull.                                                                  |                                                        |
| `ExportProgressCard`               | stat   | Account export progress, file size, download link.                                                                 |                                                        |
| `OnboardingCatalogCard`            | list   | Onboarding wizard catalog: AI/Storage/Deploy cards + plugins.                                                      |                                                        |
| `SubscriptionPlanCard`             | detail | Current subscription plan, cadences, upgrade/downgrade.                                                            |                                                        |
| `NotificationsList`                | table  | Notifications with category/read-status/search filter.                                                             |                                                        |
| `NotificationUnreadBadge`          | stat   | Unread notification count badge for nav/header.                                                                    |                                                        |
| `PersistentNotificationsBanner`    | other  | Prominent banner for critical persistent notifications.                                                            |                                                        |
| `EventTypesList`                   | table  | Notification event types with subscription status.                                                                 |                                                        |
| `NotificationPreferencesPanel`     | detail | Edit notification prefs: quiet hours, mutes, per-event channels.                                                   |                                                        |
| `NotificationChannelsList`         | table  | Notification channels with edit/delete/test actions.                                                               |                                                        |
| `NotificationChannelForm`          | form   | Create/edit notification channel with type-specific fields.                                                        |                                                        |
| `BudgetListTable`                  | table  | Work budgets: scope/plugin/cap/overage with edit/delete.                                                           |                                                        |
| `BudgetDetailCard`                 | form   | Create/edit single budget (cap, overage, currency).                                                                |                                                        |
| `UsageSummaryCard`                 | stat   | Current-period usage: total spend, per-plugin breakdown, cap gauge.                                                | BudgetOverviewCard exists in dashboard                 |
| `UsageTrendChart`                  | chart  | Daily spend buckets across billing period.                                                                         | SpendTrendCard recharts component                      |
| `AccountWideBudgetCard`            | stat   | Current-month total spend across account + cap gauge.                                                              |                                                        |
| `AdminUsageTable`                  | table  | Admin-only per-(user,work) spend rows, filterable by period.                                                       |                                                        |
| `EmailAddressListTable`            | table  | Tenant email addresses with direction/verification/default-reply.                                                  |                                                        |
| `EmailAddressDetailCard`           | detail | Single email address provider settings, verification, disabled toggle.                                             |                                                        |
| `EmailMessageListTable`            | table  | Paginated email messages per agent with status/timestamps.                                                         |                                                        |
| `EmailMessageDetailCard`           | detail | Full email message: headers, body, delivery events.                                                                |                                                        |
| `EmailAddressSetupFlow`            | form   | Guided email address registration + verification wizard.                                                           |                                                        |
| `ActivityLogTable`                 | table  | Paginated filterable activity log with search/date/status.                                                         | ActivityTable exists in dashboard                      |
| `ActivityBadge`                    | stat   | Count of in-progress operations for sidebar.                                                                       |                                                        |
| `ActivitySummaryCard`              | stat   | Activity counts grouped by status.                                                                                 |                                                        |
| `ActivityDetailCard`               | detail | Full activity detail with live logs and metadata.                                                                  |                                                        |
| `WebhookSubscriptionList`          | table  | Active webhook subscriptions with status/URL/actions.                                                              |                                                        |
| `WebhookDeliveriesList`            | table  | Webhook delivery history with status and redeliver.                                                                |                                                        |
| `TemplateList`                     | table  | Templates by kind with default indicator (shared with TemplatesList).                                              |                                                        |
| `CustomizationDetailCard`          | detail | Template customization run status/branch/commit/error.                                                             |                                                        |
| `CustomizationList`                | table  | Customization runs for a template with status timeline.                                                            |                                                        |
| `ScreenshotAvailabilityCard`       | stat   | Screenshot provider configuration status.                                                                          |                                                        |
| `SearchAvailabilityCard`           | stat   | Web-search provider availability status.                                                                           |                                                        |
| `SearchResultsList`                | list   | Web search results with snippets/links/source metadata.                                                            |                                                        |
| `AgentMemoryAvailabilityCard`      | stat   | Agent-memory provider availability status.                                                                         |                                                        |
| `ReportChart`                      | chart  | Generic recharts renderer for the 95 catalogued reports (line/bar/pie/donut/area/gauge/stacked/timeseries).        | recharts SpendTrendCard chart primitives               |

## 7. Reports (sample)

Each becomes a `run_report` target: fetch source data -> aggregate -> render a chart in canvas. Full list in the JSON.

| Domain                          | Report                          | Question                                                                                                                      | Viz               |
| ------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| works-core                      | Work Activity Overview          | What is the activity breakdown across my works (generated items, updates, comparisons)?                                       | bar-chart         |
| works-core                      | Generation History Trend        | How many items were generated and when across each work?                                                                      | line-chart        |
| works-core                      | Item Health Status Distribution | What percentage of items have passing vs failing health checks?                                                               | pie-chart         |
| works-core                      | Schedule Execution Record       | How many scheduled updates have run and what were the results?                                                                | bar-chart         |
| works-core                      | Comparison Generation Pace      | How many comparisons remain vs completed across works?                                                                        | stacked-bar-chart |
| works-core                      | Repository Sync Events          | When and how often has work data been synced from repositories?                                                               | timeline          |
| works-core                      | Taxonomy Growth                 | How many categories, tags, and collections exist per work?                                                                    | grouped-bar-chart |
| works-core                      | Community PR Processing         | How many items have been added via community PRs over time?                                                                   | area-chart        |
| works-items-taxonomy            | Items by Category Distribution  | How many items are assigned to each category in this work?                                                                    | bar               |
| works-items-taxonomy            | Items by Tag Distribution       | What is the distribution of items across tags?                                                                                | pie               |
| works-items-taxonomy            | Source Health Status            | How many items have healthy, broken, or warning-level source URLs?                                                            | donut             |
| works-items-taxonomy            | Featured vs Unfeatured Items    | What percentage of items are marked as featured?                                                                              | gauge             |
| works-items-taxonomy            | Item Addition Timeline          | How many items were added over time (by date)?                                                                                | line              |
| generation-comparisons-schedule | Generation Activity Timeline    | What is the history of generation runs for this work (dates, durations, item counts, status)?                                 | TimelineChart     |
| generation-comparisons-schedule | Comparison Generation Coverage  | How many comparison pairs have been generated vs remain? What percentage of possible pairs are covered?                       | DonutChart        |
| generation-comparisons-schedule | Schedule Execution History      | How many scheduled updates have run, when did they run, and what was the outcome (success/failure)?                           | BarChart          |
| generation-comparisons-schedule | Generation Success Rate         | What is the success rate of generation runs over time? Which item types or sizes have higher failure rates?                   | LineChart         |
| website-deploy-git              | Deployment Activity Timeline    | What is the deployment history and activity for this work over time?                                                          | TimelineChart     |
| website-deploy-git              | Domain Verification Status      | Which custom domains are verified and which ones still need DNS configuration?                                                | DonutChart        |
| website-deploy-git              | Provider Configuration Coverage | Which deployment/git/OAuth providers does the user have configured?                                                           | BarChart          |
| website-deploy-git              | Website Template Usage          | Which website templates are most commonly selected across works?                                                              | BarChart          |
| agents                          | Agent Activity Timeline         | What is the run activity for my agents over the last 7/30 days? (runs by status, trigger kind distribution, duration trends)  | LineChart         |
| agents                          | Agent Budget Spend              | Which agents are spending the most? (current-period spend by agent, spend vs cap, top spenders by plugin category)            | BarChart          |
| agents                          | Agent Status Distribution       | What is the health of my agent fleet? (count by status: ACTIVE, PAUSED, ERROR, ARCHIVED; run success rate by agent)           | PieChart          |
| agents                          | Skill Binding Coverage          | Which skills are bound to agents and how? (skill usage count, binding priority distribution, target type breakdown)           | TableChart        |
| agents                          | Agent Scope & Ownership         | How are agents distributed across scopes? (count by scope: PERSONAL, MISSION, IDEA, WORK; agents per parent entity)           | BarChart          |
| agents                          | Memory Session Metrics          | How much is my agent memory being used? (session count, active vs closed ratio, memory search volume, entry count by project) | LineChart         |
| tasks                           | Task Activity Trend             | How many tasks have been created, transitioned, and completed over the last 30 days?                                          | line              |
| tasks                           | Status Distribution             | What is the distribution of my tasks across different statuses?                                                               | pie               |
| tasks                           | Priority Breakdown              | How many tasks are assigned to each priority level?                                                                           | bar               |
| tasks                           | Task Completion Rate            | What percentage of created tasks reach completion status by week?                                                             | line              |
| tasks                           | Task Spend by Priority          | How much spend is associated with tasks at each priority level?                                                               | bar               |
| tasks                           | Assignee Workload               | Which assignees (users/agents) have the most tasks assigned to them?                                                          | bar               |
| tasks                           | Blocker Impact                  | How many tasks are currently blocked and how long have they been blocked?                                                     | table             |
| tasks                           | Chat Activity per Task          | Which tasks have the most chat messages and engagement?                                                                       | bar               |
| missions-ideas-workagent        | Mission Activity Trends         | How many missions were created, paused, resumed, or completed by month over the past 6 months?                                | line              |
| missions-ideas-workagent        | Idea Generation Volume          | How many work proposals (ideas) were generated per day from refreshes vs user-manual creation?                                | bar               |
| missions-ideas-workagent        | Idea Build Success Rate         | What percentage of queued ideas successfully build to completion vs fail? Show trend over time.                               | line              |
| missions-ideas-workagent        | Budget Spend by Owner           | Which missions and ideas have consumed the most budget in the current period? Show % of cap remaining.                        | bar               |
| missions-ideas-workagent        | Work Agent Goal Completion      | What is the success rate of work agent goals? How long does a typical goal take from creation to completion?                  | line              |

_...and 55 more in [`operations-inventory.json`](./operations-inventory.json)._

## 8. Build waves

**Wave 1 - Foundation: tool generator, confirmation gate, no-bulk guard, canvas shell**  
Build the manifest-driven chat-tool generator that emits single-entity tools from each domain's operations manifest (path/method/kind/singleEntity/requiresConfirmation/canvasComponent). Implement the confirmation gate (confirm_action) wired to every requiresConfirmation tool, a no-bulk guard that hard-excludes singleEntity:false write operations and excludeReason:'bulk', auth/scope passthrough (tenant/org/work scoping), and the canvas shell with the 8 cross-cutting render/report primitives. Define the persisted canvas-artifact message schema so renders survive reload. - domains: works-core, budgets-usage-billing

**Wave 2 - Canvas renderers + existing-component embedding**  
Implement the deduped canvas catalog: generic table/detail/form/stat renderers plus ReportChart, and the show_component bridge that embeds existing dashboard components (ActivityTable, BudgetOverviewCard/UsageSummaryCard, AgentCard, ItemsList, SpendTrendCard). Establishes the rendering contract every later wave reuses. - domains: budgets-usage-billing, activity-webhooks-files-templates, agents

**Wave 3 - Core works lifecycle tool batch**  
Generate and ship the largest batch: works CRUD, items, taxonomy (categories/tags/collections), generation/update, schedule, comparisons, import/export, website settings. Wire WorksList/WorkDetailCard/ItemsList/TaxonomyList/HistoryTimeline/GenerationProgressCard/ScheduleDetailCard/Comparison renderers. - domains: works-core, works-items-taxonomy, generation-comparisons-schedule

**Wave 4 - Agents, tasks, missions/ideas tool batch**  
Ship agent CRUD + runs + files + memory, task CRUD + assignees/reviewers/approvers/blockers/chat/spend, and missions/ideas/work-agent goals. Wire Agent, Task, Mission, WorkProposal, WorkAgentGoal/Run renderers and BudgetCard reuse. - domains: agents, tasks, missions-ideas-workagent

**Wave 5 - Skills, knowledge base, plugins/integrations tool batch**  
Ship skills catalog/install/bindings, KB documents/tags/uploads/inheritance (work + org scoped), and plugins/work-plugins/Composio/device-auth. Wire Skill, Kb, Plugin, Composio, DeviceAuthStatusCard renderers. - domains: skills, knowledge-base, plugins-integrations

**Wave 6 - Deploy/git, orgs/members, auth/account, notifications, email tool batch**  
Ship deployment providers/domains/rollback, git/GitHub-app/OAuth connection reads, organizations + work members/invitations, auth/profile/API-keys/account-sync/onboarding/subscription, notifications + channels + preferences, and email addresses/messages. Wire remaining detail/table/form/setup-flow renderers. - domains: website-deploy-git, orgs-tenants-members, auth-account-security, notifications, email-comms

**Wave 7 - Reports engine + remaining utility surfaces**  
Implement run_report against the 95 catalogued reports (aggregation + ReportChart rendering), plus activity/webhooks/files/templates/screenshot/search utility tools and availability cards. Hardens token-budget handling (lazy/grouped tool-schema loading) across the full 419-tool surface. - domains: activity-webhooks-files-templates, budgets-usage-billing, works-core

## 9. Risks & mitigations

- OpenAPI/Swagger is disabled in production, so the tool generator cannot scrape live schemas in prod; tool definitions must be generated at build time from committed per-domain manifests and shipped as static artifacts.
- Token bloat: 419 chat tools with full JSON schemas will exceed the model context window. Need lazy/grouped tool exposure (load domain tool batches on demand, or a search-and-fetch discovery layer) instead of injecting all 432 schemas every turn.
- Auth/scope correctness: tools span personal (/api/me/_), tenant, org (/api/organizations/:orgId/_) and work (/api/works/:id/\*) scopes. The generator must propagate the caller's active tenant/org/work context and enforce server-side authorization, not trust model-supplied IDs.
- Confirmation-gate integrity: 53 destructive/requiresConfirmation operations must be impossible to execute without an approved confirm_action; the model must not bypass via re-phrased or chained calls. Gate must be enforced server-side, not just in the prompt.
- No-bulk guard must be airtight: bulk endpoints (bulk_delete_items, bulk_update_items, bulk_publish_items, batch_deploy_works, bulk_capture_images) and OAuth/webhook/telemetry callbacks are excluded; the generator must hard-exclude singleEntity:false writes and excludeReason rows and never auto-loop a single-entity tool to fake bulk.
- Canvas artifact persistence: rendered charts/tables/detail/form panels must be serialized into message history (data + component name + props) so they survive reload and don't silently re-fetch stale or unauthorized data on replay.
- Component-embedding coupling: show_component embeds existing dashboard components (ActivityTable, BudgetOverviewCard, AgentCard, SpendTrendCard, ItemsList) whose prop contracts can drift; need a stable adapter layer and version pinning so canvas embeds don't break on dashboard refactors.
- Duplicate/aliased operations and naming collisions across domains (list_works in 2 domains; upload_image vs upload_image_alias; AttachmentList vs AttachmentListCard; MemorySession\* in agents and activity domains) require a global dedupe + canonical-name registry to avoid conflicting tools.
- Long-running/async actions (generate_items, deploy_work, customize_template, refresh_work_proposals, account export/sync) return job handles not final results; canvas needs polling/streaming progress components (GenerationProgressCard, ExportProgressCard) and the model must not fabricate completion.
- Reports engine has no dedicated aggregation endpoints for most of the 95 reports; run_report must derive aggregates from list endpoints, risking heavy fan-out, pagination limits, and inconsistent metrics; needs a defined aggregation contract and caching.

## 10. Shipped in this PR (Waves 1-13)

- **Engine:** `apps/web/src/lib/ai/tools/generated/{api-call,registry,factory}.ts` - manifest-driven tool generator with the no-bulk guard + confirmation gate baked in.

- **Registry (Waves 1-5, ~300 generated tools):**
    - Wave 1 (`registry.ts`) - ~80 hand-curated single-entity tools across agents, tasks, skills, notifications, work members, API keys, budgets/usage, webhooks, organizations, knowledge base, templates, plugins.
    - Wave 2 (`registry.wave2.ts`) - +200 tools across 13 domains with **real DTO-derived body hints** (works config/website/taxonomy, comparisons, deploy domains/rollback, git/github/oauth reads, agent runs/files/attachments, task relations/blocks, mission/idea attachments, work-agent goals, composio/device-auth, KB uploads/locks/inheritable, auth/account/onboarding/subscriptions, notification prefs, email, activity log, templates, screenshot/search/agent-memory).
    - Wave 3 (`registry.wave3.ts`) - the remaining read/report GET tools, generated deterministically from the inventory.
    - Wave 5 (`registry.wave5.ts`) - the single-entity **mutation tail** (generate_work_details, cancel_generation, register_company, leave_work, task attachments, event subscription, …). After Wave 5, every `includeInChat` operation has a tool except the deliberately policy-excluded ones (bulk, anonymous uploads, logout-all, redundant aliases).
    - `registry.all.ts` merges and dedupes all waves (earlier waves win). Works/items/missions/ideas/deploy/schedule already ship as hand-written tools and are not duplicated.

- **Per-turn tool gating** (`tool-selection.ts`): the full ~300-tool set stays available, but each turn surfaces only an always-on core (navigation, canvas, search, user, works) plus the tools whose domain matches the latest message / current page, capped at 90 - keeping the schema payload bounded and well under provider function-count limits.

- **Canvas (~24 renderers):** `apps/web/src/components/ai/canvas/*` - `CanvasArtifactView` (recharts **chart + table + stat + detail + kanban**) and `components.tsx` (a **19-component bespoke registry**: progress, gauge, timeline, comparison, markdown, gallery, funnel, metric_delta, donut, sparkline, bars, kpi, steps, badges, json, code, heatmap, rating, calendar — Waves 7/9/10/18/20/23); `lib/ai/tools/canvas.tools.ts` (`renderChart/Table/StatCards/Detail` + **`showComponent`**). Render-tested.

- **Reports engine (Waves 4/6/8/11/12/17/19/22/23):** `lib/ai/tools/reports.ts` + pure `reports-aggregate.ts` - `run_report` fetches data as the logged-in user, aggregates it, and renders a chart/stat/kanban/board into the canvas in one call. **~76 named reports** built from `groupReport`/`countReport`/`timeseriesReport` factories (distributions, counts, per-day trends across works/items/tasks/agents/missions/ideas/plugins/kb/notifications/email/webhooks/orgs/skills/deploy/comparisons), including the flagship **`work_items_per_day`**. Plus **`build_report`** — group-by-charts ANY of **19 list sources** by ANY field. `list_reports` lists the catalogue. All always-on core tools.

- **Wiring:** merged into `buildChatTools()`; `agent.ts` gates tools per turn; system prompt updated with the safety + canvas + report rules; `ChatToolResult` renders the confirmation card, canvas chip, and bulk-rejection notice; `ChatInterface` mounts the canvas.

- **Tests (Wave 13):** Vitest unit specs for the safety-critical logic — `factory` (path/query routing, body forwarding, **destructive-without-confirmed → no API call**, confirmed → proceeds, **bulk id-array rejection**) and `tool-selection` (core always-on, keyword/page domain matching, cap). 11 tests green.

- **Verified:** web `tsc --noEmit` clean, `eslint` clean, `prettier` clean, unit tests green; CI green on each push.

### Status & next steps

**Done — the goal is functionally met:** every single-entity operation the UI exposes is a chat tool (Waves 1-5), auth-scoped, with **confirm-before-destructive**, **no-bulk**, and per-turn gating; the canvas renders charts/tables/stats/detail/kanban + six bespoke components; analytics are turnkey (~21 reports) **and** generalized (`build_report`); the safety logic is unit-tested. A user can drive the platform's operations and reporting from chat instead of the UI.

**What's deliberately NOT mass-produced:** the literal remainder of the 113-component catalog and 95 named reports (sections 6-7) is now **covered by the generalized mechanisms** — `show_component`'s extensible registry and `build_report` — so hardcoding each remaining entry adds catalogue breadth, not new capability. Add bespoke entries where a domain genuinely needs a tailored layout. Some generated mutations use a generic `body` object + DTO hint rather than a field-level schema.

**Highest-value next gate:** a **live smoke test** of the chat against this branch — the model/tool loop (tool selection, confirmation handshake, canvas rendering) can't be exercised from CI and should be QA'd before broad rollout.
