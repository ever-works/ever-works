import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
	platformSidebar: [
		'index',
		'overview',
		'getting-started',
		'installation',
		'development-workflow',
		'environment-variables',
		'monorepo-structure',
		{
			type: 'category',
			label: 'Architecture',
			link: { type: 'doc', id: 'architecture' },
			items: [
				'architecture/agent-package',
				'architecture/pipeline-system',
				'architecture/event-system',
				'architecture/generator-system',
				'architecture/facade-pattern',
				'architecture/contracts-package',
				'architecture/web-app',
				'architecture/caching',
				'architecture/events-deep-dive',
				'architecture/dependency-injection',
				// Agents/Skills/Tasks PR #1017 — reference for the 6 new
				// Nest injection tokens (dispatchers, post-processors,
				// git facade, plugin-tools facade) operators bind to
				// custom adapters.
				'architecture/agent-injection-tokens',
				// EW-639 Phase 3 — end-to-end plugin system overview
				// (lifecycle, AiOperations, JSON-Schema extensions,
				// category registry, AiFacadeService selection,
				// authoring, bundled-vs-dynamic distribution / EW-693,
				// storage plugins + KB usage).
				'architecture/plugins',
				'architecture/module-system',
				'architecture/middleware-pipeline',
				'architecture/configuration-management',
				'architecture/dto-validation',
				'architecture/error-handling-patterns',
				'architecture/guards-interceptors',
				'architecture/nestjs-modules',
				'architecture/typeorm-patterns'
			]
		},
		{
			type: 'category',
			label: 'Features',
			collapsed: false,
			link: { type: 'doc', id: 'features/index' },
			items: [
				// A new user's first two screens, in the order they meet
				// them: create the account, then walk the setup wizard.
				// The settings map follows the wizard because every choice
				// the wizard makes is changed there afterwards.
				'features/creating-an-account',
				'features/creating-a-work',
				// What a Work's kind decides (website, landing page, blog,
				// directory, awesome repo, plus the company and campaign
				// kinds minted by their own flows). Sits with the creation
				// pages because kind is chosen at creation and never after.
				'features/work-kinds',
				'features/onboarding',
				'features/settings-map',
				// The three screens every session passes through: the home
				// cockpit, the unified /new creation surface, and the chat
				// rail that can drive both. They follow the settings map
				// because that is where the wizard's choices are changed.
				'features/dashboard',
				'features/new-page',
				'features/platform-chat',
				'features/missions',
				'features/ideas',
				'features/goals',
				// A campaign Work is a Goal with a go-to-market pipeline and
				// a seeded agent bench behind it, so it reads straight after
				// Goals rather than with the other Work kinds.
				'features/campaigns',
				'features/tasks',
				// The webhook-to-Task edge of Tasks: a signed HTTPS call or a
				// matched platform event spawns a Task and hands it to an
				// Agent, so it sits between the two pages it joins.
				'features/inbound-triggers',
				'features/agents',
				'features/agents-catalog',
				'features/skills-catalog',
				'features/plugins',
				'features/agent-email',
				// The operator's message center: the queue an agent writes to
				// when it needs a human, next to the email surface it sits
				// beside in the sidebar.
				'features/inbox',
				'features/mission-templates',
				// 2026-07 feature program — how agent work is isolated,
				// verified, landed and steered. These four read as one
				// chain (branch → checks → merge → live control), so they
				// are listed together and before the money/ops pages.
				'features/task-isolation',
				'features/quality-gates',
				'features/merge-policy',
				// Not part of that chain — Agent Capabilities is Merge
				// Policy's sibling matrix (same four-scope lattice,
				// opposite default), so it is listed next to it.
				'features/agent-capabilities',
				'features/sessions-and-steering',
				// The human-in-the-loop layer above a session (guardrails,
				// the approval queue, escalations), then the two per-Agent
				// readouts you watch a session through: its scorecard and
				// its live terminal.
				'features/approvals-and-escalations',
				'features/agent-scorecards',
				'features/agent-terminals',
				'features/memory-decisions',
				// Meetings is a memory SOURCE (its catalog renders inside the
				// Memory page), so it reads next to the memory pages rather
				// than next to the connectors that feed it.
				'features/meetings',
				'features/budgets-and-usage',
				'features/credits-and-billing',
				'features/knowledge-base',
				// The org-wide layer above a single Work's KB: shared
				// documents, the review queue, consolidation and recall.
				// Reads straight after the KB it generalises; its two
				// sources, Decisions and Meetings, are listed above.
				'features/memory',
				'features/autonomous-operation',
				'features/workers',
				'features/job-runtimes',
				// The named runtime an Agent run is handed (packages,
				// networking, allowed hosts). Sits between the runtime and
				// the credential layers because it is the third thing an
				// execution host resolves before it starts.
				'features/environments',
				// Secret Stores is the credential-reference layer the
				// job-runtime tenant overlay reads, so it follows the
				// two runtime pages rather than sitting with plugins.
				'features/secret-stores',
				'features/store-builder',
				'features/company-builder',
				'features/desktop-app',
				// Fleet is the registry the Desktop App enrolls into —
				// keep it adjacent so the two read together.
				'features/fleet',
				'features/integrations',
				// The connector catalog is the per-provider detail behind
				// Integrations — keep the two adjacent.
				'features/connectors',
				// The other side of the same wire: external MCP servers
				// registered under Settings > Connections and bound per
				// Agent. Sits with the connection surfaces, not with
				// features/mcp-server (which is Ever Works AS an MCP
				// server, further down this list).
				'features/mcp-connections',
				// The account-level registry of Git repositories that are NOT
				// a Work's own repos, attached per Agent from the same
				// Capabilities screen as Skills and MCP connections.
				'features/repositories',
				'features/community-pr-processing',
				'features/work-changelog',
				'features/collections',
				// The Items workbench and its bulk CSV/Excel path. Both sit next
				// to Collections because the four pages describe one surface: the
				// items themselves, how they are grouped, how they move in and out
				// of the Work in bulk, and how their source URLs are checked.
				'features/items',
				'features/item-import-export',
				'features/item-source-validation',
				'features/scheduled-updates',
				'features/activity',
				// The delivery surfaces for everything above: the bell and its
				// channels, then the scheduled briefing built on the same stack.
				'features/notifications',
				'features/digests',
				'features/generation-cancellation',
				'features/works-config',
				'features/work-import',
				'features/work-members',
				'features/teams',
				'features/organizations',
				'features/comparisons',
				'features/advanced-prompts',
				'features/git-operations',
				'features/taxonomy-system',
				'features/api-keys',
				'features/custom-domains',
				'features/website-templates',
				'features/generated-site',
				'features/work-templates',
				// The third catalog behind the other two: the manifest in the
				// public works repository that seeds the blueprint picker.
				'features/work-blueprints',
				'features/k8s-deployment',
				'features/managed-hosting',
				// Where uploaded bytes land (local-fs / S3 / MinIO / GitHub
				// + LFS). An operator-level STORAGE_BACKEND choice, so it
				// reads with the deployment pages rather than with the
				// features that produce the uploads.
				'features/storage-backends',
				'features/mcp-server',
				'features/data-management'
			]
		},
		{
			type: 'category',
			label: 'Guides',
			collapsed: false,
			items: [
				'guides/founder-journey',
				'guides/platform-tour',
				'guides/quickstart-directory',
				'guides/quickstart-blog',
				'guides/quickstart-landing-page',
				'guides/quickstart-website',
				'guides/quickstart-awesome-repo',
				// The hands-off counterpart to the quickstarts: template ->
				// scheduled Mission -> Ideas gears -> budgets, wired once and
				// then watched from Sessions, Schedules and the Inbox. Reads
				// after them because it assumes you have built one Work by hand.
				'guides/autonomous-site-from-template',
				// The workforce guide the autonomous one implies: Mission ->
				// Goals -> hired Agents -> Teams -> heartbeats, budgets and
				// guardrails, then the surfaces you operate them from.
				'guides/run-your-business-24-7',
				// "Chat does everything" as a task guide: ten worked prompts,
				// each mapped to a tool that is actually registered in
				// apps/web/src/lib/ai/tools. Sits after the quickstarts
				// because it drives the surfaces they create.
				'guides/do-everything-from-chat',
				// The catalogs the quickstarts pick from, in one place:
				// website templates, Work templates, blueprints, Mission,
				// Agent, Skill and Task templates.
				'guides/templates-catalogs',
				// Seeding a Work's Knowledge Base from real files, reviewing
				// what the agents wrote back, the org-wide Memory layer above
				// it and the five Agent definition files. Sits after the
				// Work-building guides because it assumes a Work exists to
				// hang knowledge off.
				'guides/knowledge-base-and-memory',
				// Every ceiling in one place - account, Work, Agent, run
				// concurrency, tool grants, merge policy - and safe defaults
				// for a new team. Follows the workforce guide it constrains.
				'guides/budgets-and-guardrails',
				// Adding people to the picture: Organizations, invitations,
				// Teams, the org chart and Work members.
				'guides/teams-and-organizations',
				// Wiring the outside world in and out: the Slack app, the
				// GitHub App, connector plugins, notification channels.
				'guides/connect-integrations',
				// Shipping a Work and bringing one in: the deploy-target and
				// custom-domain guide, then the four ways an existing
				// repository becomes a Work (copy, link, .works/works.yml,
				// GitHub App installation).
				'guides/custom-domains-and-deploy-targets',
				'guides/import-an-existing-repo',
				// Bringing your own model keys, then the three machine
				// surfaces the platform speaks through: MCP clients, the
				// CLI and the desktop app.
				'guides/bring-your-own-ai-provider',
				'guides/mcp-server-setup',
				'guides/cli-quickstart',
				'guides/desktop-app',
				// Operator-facing guide: the five Compose files, the boot-time
				// env checks, the GHCR images and the .deploy/k8s manifests.
				// Last in Guides because it is about running the platform
				// rather than building a Work with it.
				'guides/self-host-docker-kubernetes'
			]
		},
		{
			// EW-639 Phase 3 — KB user-facing docs (concepts, classes,
			// locks, transcription, inherited org docs) + the machine
			// access surfaces (MCP `kb.*` tools and `ever works kb`
			// CLI subcommands). Sits between Guides and API Reference
			// so end-user concepts come before raw REST.
			type: 'category',
			label: 'Knowledge Base',
			items: ['kb/user-guide', 'kb/mcp-cli-reference']
		},
		{
			type: 'category',
			label: 'API Reference',
			items: [
				'api/index',
				'api/authentication',
				'api/works',
				// Agents/Skills/Tasks PR #1017 — Phase 20.2 reference
				// pages for the 3 new feature families.
				'api/agents',
				'api/skills',
				'api/tasks',
				'api/ai-conversation',
				'api/deployment',
				'api/other-modules',
				'api/subscriptions',
				'api/notifications',
				'api/mail',
				'api/plugins-api',
				'api/plugin-capabilities',
				'api/twenty-crm',
				'api/email-templates',
				'api/integrations-module',
				'api/screenshot-capability',
				'api/deploy-capability',
				'api/git-provider-capability',
				'api/oauth-capability',
				'api/search-capability',
				'api/device-auth-capability',
				'api/activity-log',
				'api/template-catalog',
				'api/account',
				'api/error-handling',
				'api/guards-interceptors',
				'api/websocket-events'
			]
		},
		{
			type: 'category',
			label: 'CLI Reference',
			items: [
				'cli/index',
				'cli/commands',
				'cli/auth-commands',
				'cli/work-commands',
				'cli/internal-cli',
				'cli/plugin-commands',
				'cli/generation-commands'
			]
		},
		{
			type: 'category',
			label: 'AI & Generation',
			items: [
				'ai-agents/index',
				'ai-agents/model-router',
				'ai-agents/data-generation',
				'ai-agents/markdown-generation',
				'ai-agents/website-generation'
			]
		},
		{
			type: 'category',
			label: 'Database',
			link: { type: 'doc', id: 'database' },
			items: ['database/entities', 'database/repositories', 'database/migrations']
		},
		{
			type: 'category',
			label: 'Plugin System',
			items: [
				'plugin-system/index',
				'plugin-system/architecture',
				'plugin-system/settings',
				'plugin-system/creating-a-plugin',
				{
					type: 'category',
					label: 'Category Guides',
					collapsed: false,
					items: [
						'plugin-system/creating-ai-provider-plugin',
						'plugin-system/creating-search-plugin',
						'plugin-system/creating-screenshot-plugin',
						'plugin-system/creating-content-extractor-plugin',
						'plugin-system/creating-pipeline-plugin',
						'plugin-system/creating-deployment-plugin',
						'plugin-system/creating-data-source-plugin'
					]
				},
				'plugin-system/built-in-plugins',
				'plugin-system/api-reference',
				'plugin-system/plugin-categories',
				'plugin-system/ai-provider-plugins',
				'plugin-system/search-plugins',
				'plugin-system/content-extraction-plugins',
				'plugin-system/deployment-plugins',
				'plugin-system/data-source-plugins',
				'plugin-system/pipeline-plugins',
				'plugin-system/testing-plugins',
				'plugin-system/brave-search-plugin',
				'plugin-system/exa-search-plugin',
				'plugin-system/jina-plugin',
				'plugin-system/firecrawl-plugin',
				'plugin-system/github-plugin',
				'plugin-system/vercel-plugin',
				'plugin-system/openai-plugin',
				'plugin-system/anthropic-plugin',
				'plugin-system/ollama-plugin',
				'plugin-system/lm-studio-plugin',
				'plugin-system/vllm-plugin',
				'plugin-system/groq-plugin',
				'plugin-system/tavily-plugin',
				'plugin-system/apify-plugin',
				'plugin-system/notion-plugin',
				'plugin-system/mistral-plugin',
				'plugin-system/perplexity-plugin',
				'plugin-system/openrouter-plugin',
				'plugin-system/scrapfly-plugin',
				'plugin-system/brightdata-plugin',
				'plugin-system/google-ai-plugin',
				'plugin-system/deepseek-plugin',
				'plugin-system/xai-plugin',
				'plugin-system/together-plugin',
				'plugin-system/fireworks-plugin',
				'plugin-system/cohere-plugin',
				'plugin-system/serpapi-plugin',
				'plugin-system/urlbox-plugin',
				'plugin-system/screenshotone-plugin',
				'plugin-system/valyu-plugin',
				'plugin-system/pdf-extractor-plugin',
				'plugin-system/local-extractor-plugin',
				'plugin-system/local-content-extractor-plugin',
				'plugin-system/agent-pipeline-plugin',
				'plugin-system/standard-pipeline-plugin',
				'plugin-system/comparison-generator-plugin',
				'plugin-system/claude-code-plugin',
				'plugin-system/claude-managed-agent-plugin',
				'plugin-system/codex-plugin',
				'plugin-system/gemini-plugin',
				'plugin-system/opencode-plugin',
				'plugin-system/make-plugin',
				'plugin-system/sim-ai-plugin',
				'plugin-system/zapier-plugin',
				'plugin-system/composio-plugin',
				'plugin-system/activepieces-plugin',
				'plugin-system/linkup-plugin',
				'plugin-system/langfuse-plugin',
				'plugin-system/vercel-ai-gateway-plugin',
				'plugin-system/github-plugin-deep-dive',
				'plugin-system/vercel-plugin-deep-dive',
				'plugin-system/openai-plugin-deep-dive',
				'plugin-system/anthropic-plugin-deep-dive',
				'plugin-system/firecrawl-plugin-deep-dive',
				'plugin-system/brave-plugin-deep-dive',
				'plugin-system/notion-plugin-deep-dive',
				'plugin-system/apify-plugin-deep-dive',
				'plugin-system/ollama-plugin-deep-dive',
				'plugin-system/exa-plugin-deep-dive',
				'plugin-system/standard-pipeline-deep-dive',
				'plugin-system/agent-pipeline-deep-dive',
				'plugin-system/claude-code-deep-dive',
				'plugin-system/pdf-extractor-deep-dive',
				'plugin-system/groq-plugin-deep-dive',
				'plugin-system/google-plugin-deep-dive',
				'plugin-system/mistral-plugin-deep-dive',
				'plugin-system/openrouter-plugin-deep-dive',
				'plugin-system/screenshotone-deep-dive',
				'plugin-system/urlbox-deep-dive'
			]
		},
		{
			type: 'category',
			label: 'Agent Services',
			items: [
				'agent-services/work-lifecycle',
				'agent-services/works-yml-schema',
				'agent-services/work-generation',
				'agent-services/work-scheduling',
				'agent-services/repository-management',
				'agent-services/items-generator',
				'agent-services/generator-form-schema',
				'agent-services/work-query',
				'agent-services/work-members',
				'agent-services/dto-reference',
				'agent-services/config-module',
				'agent-services/work-detail-service',
				'agent-services/work-import-service',
				'agent-services/work-ownership-service',
				'agent-services/work-taxonomy-service',
				'agent-services/work-schedule-dispatcher',
				'agent-services/distributed-task-lock',
				'agent-services/work-advanced-prompts',
				'agent-services/community-pr-service',
				'agent-services/import-system',
				'agent-services/comparison-generator-service',
				'agent-services/agent-dto-reference',
				'agent-services/agent-work-module',
				'agent-services/agent-generation-module',
				'agent-services/agent-pipeline-module',
				'agent-services/agent-taxonomy-module',
				'agent-services/agent-items-module',
				'agent-services/agent-deployment-module',
				'agent-services/agent-ai-module',
				'agent-services/agent-storage-module',
				'agent-services/agent-scheduling-module',
				'agent-services/agent-integration-module',
				'agent-services/cache-module',
				'agent-services/constants-module',
				'agent-services/database-module',
				'agent-services/entities-module',
				'agent-services/events-module',
				'agent-services/facades-module',
				'agent-services/notifications-module',
				'agent-services/pipeline-module',
				'agent-services/plugins-module',
				'agent-services/subscriptions-module',
				'agent-services/work-operations-module'
			]
		},
		{
			type: 'category',
			label: 'Packages',
			items: [
				'packages/tasks-package',
				'packages/monitoring-package',
				'packages/cli-shared-package',
				'packages/plugin-api-layer',
				'packages/plugin-ai-module',
				'packages/plugin-git-module',
				'packages/plugin-helpers',
				'packages/plugin-keywords',
				'packages/plugin-testing-framework',
				'packages/contracts-types',
				'packages/agent-package-overview',
				'packages/plugins-package-overview'
			]
		},
		{
			type: 'category',
			label: 'DevOps & Deployment',
			items: [
				'devops/docker',
				'devops/ci-cd',
				'devops/digital-ocean',
				'devops/monitoring',
				'devops/trigger-dev',
				'devops/scaling',
				'devops/security',
				'devops/github-workflows-deep-dive',
				'devops/docker-compose',
				'devops/environment-management',
				'devops/logging-aggregation',
				'devops/disaster-recovery',
				'devops/performance-monitoring',
				'devops/kubernetes',
				'devops/k8s-e2e-runbook'
			]
		},
		{
			type: 'category',
			label: 'Web Dashboard',
			items: [
				'web-dashboard/overview',
				'web-dashboard/components',
				'web-dashboard/configuration',
				'web-dashboard/server-actions',
				'web-dashboard/hooks-reference',
				'web-dashboard/ai-components',
				'web-dashboard/settings-pages',
				'web-dashboard/api-client',
				'web-dashboard/work-pages',
				'web-dashboard/plugin-pages',
				'web-dashboard/auth-pages',
				'web-dashboard/generation-ui',
				'web-dashboard/navigation-routing',
				'web-dashboard/form-system',
				'web-dashboard/data-tables',
				'web-dashboard/deployment-ui',
				'web-dashboard/members-ui',
				'web-dashboard/history-ui',
				'web-dashboard/items-ui',
				'web-dashboard/schedule-ui',
				'web-dashboard/dashboard-layout',
				'web-dashboard/ai-components-deep-dive',
				'web-dashboard/auth-components',
				'web-dashboard/settings-components',
				'web-dashboard/ui-component-library',
				'web-dashboard/work-detail-components',
				'web-dashboard/import-flow-components',
				'web-dashboard/web-hooks-reference',
				'web-dashboard/server-actions-deep-dive',
				'web-dashboard/web-api-routes'
			]
		},
		{
			type: 'category',
			label: 'Testing',
			items: ['testing/overview', 'testing/writing-tests', 'testing/test-infrastructure']
		},
		{
			type: 'category',
			label: 'Advanced Topics',
			items: [
				'advanced/import-system',
				'advanced/comparison-generator',
				'advanced/community-pr-deep-dive',
				'advanced/subscription-billing',
				'advanced/webhook-system',
				'advanced/caching-strategy',
				'advanced/error-recovery',
				'advanced/multi-tenancy',
				'advanced/teams-and-organizations',
				'advanced/managed-deployment',
				'advanced/rate-limiting',
				'advanced/database-optimization',
				'advanced/monitoring-deep-dive',
				'advanced/security-hardening',
				'advanced/performance-tuning',
				'advanced/ai-model-routing',
				'advanced/api-versioning',
				'advanced/event-listeners',
				'advanced/pipeline-customization',
				'advanced/plugin-development-guide'
			]
		},
		{
			type: 'category',
			label: 'Resources',
			items: ['comparison', 'glossary', 'faq', 'support', 'contributing', 'changelog', 'roadmap']
		}
	]
};

export default sidebars;
