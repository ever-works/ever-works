// Base prompt applied to every agent run that customizes a fork of
// directory-web-minimal-template. It pins the agent to UI-only edits:
// CSS, Tailwind/utility classes, layout, copy tone, color tokens, etc.
// The user's request is appended to this prompt at runtime.

export const MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT = `You are customizing a fork of \`directory-web-minimal-template\` — an Astro directory website (pnpm + Turborepo monorepo).

# Goal

Apply the user's request as a complete visual design pass for the deployed directory site. Treat the request as a styling brief, not a feature request. The final result should feel professionally designed across every visible route, not only the homepage.

# Target app

Only \`apps/web/\` is deployed. Every UI edit MUST stay inside \`apps/web/\`.

Do not edit any other \`apps/*\` directory. If you see \`apps/sample-*\`, \`apps/docs\`, or \`apps/web-e2e\`, ignore them. They are upstream reference material and are stripped from user-cloned template repositories.

# Visible route surface

Review and style these visible routes as one coherent system:

- \`apps/web/src/pages/index.astro\` — homepage hero, category navigation, item grid, pagination.
- \`apps/web/src/pages/page/[page].astro\` — paginated item listing.
- \`apps/web/src/pages/item/[slug].astro\` — item detail, breadcrumbs, related items.
- \`apps/web/src/pages/categories.astro\`, \`category/[slug].astro\` — category index and category landing pages.
- \`apps/web/src/pages/tags.astro\`, \`tag/[slug].astro\` — tag index and tag landing pages.
- \`apps/web/src/pages/collections.astro\`, \`collection/[slug].astro\` — collection cards and collection detail.
- \`apps/web/src/pages/comparisons.astro\`, \`comparison/[slug].astro\` — comparison index cards and comparison detail/table.
- \`apps/web/src/pages/pages/[slug].astro\` — static content pages.
- \`apps/web/src/pages/404.astro\` — not-found state.

Feed/LLM/robots routes are data outputs; do not style them.

# Repository map

\`\`\`
apps/web/src/
  styles/global.css        PRIMARY styling lever. Tailwind v4 tokens plus selectors for [data-component] / [data-part].
  layouts/BaseLayout.astro Page chrome: document, header, footer, nav, main wrapper.
  pages/                   Astro routes. Edit visible wrappers/classes/copy tone only.
  components/              App-local UI, if present.
  lib/                     Content loaders and plugin config. DO NOT modify.

packages/ui/               Shared UI components imported as @ever-works/ui/astro/* and @ever-works/ui/preact/*.
                           DO NOT modify. Restyle via apps/web/src/styles/global.css selectors.
.content/                  Build-time cloned user content. DO NOT modify.
.deploy/, .github/, Dockerfile, package.json, astro.config.*, tsconfig.json, scripts/ DO NOT modify.
\`\`\`

# Design requirements

1. Build a coherent visual system: typography scale, spacing rhythm, page width, cards, buttons, forms/links, badges, grids, empty states, and focus states should all belong together.
2. Style all shared UI through \`global.css\` using \`[data-component=...]\` and \`[data-part=...]\` selectors. Preserve those attributes.
3. Cover both light and dark mode. This template uses the \`.dark\` class on \`<html>\`; do not use \`[data-theme=dark]\` selectors unless they already exist.
4. Keep directory UX practical: item grids must scan well, detail pages must be readable, taxonomy pages must handle many entries, and comparison pages must make competitors/verdicts easy to compare.
5. Use responsive constraints so cards, grids, nav, headings, and long names do not overlap or overflow on mobile or desktop.
6. Keep contrast at WCAG AA or better for normal text in both themes.
7. If the user request is vague, make conservative, cohesive choices across the full site and stop. Avoid decorative excess.

# Edit rules

1. UI/presentation only: CSS, Tailwind classes, layout wrappers, spacing, typography, color tokens, visible copy tone.
2. No functional changes: do not add/remove routes, change data fetching, alter props, add dependencies, or touch build/deploy config.
3. No content edits: leave \`.content/\`, item/category/tag/collection data, and Markdown content untouched.
4. No upstream package edits: never edit \`packages/ui/\`, \`packages/core/\`, \`packages/adapters/\`, \`packages/plugin-*\`, or other workspace packages.
5. Preserve imports, exports, component signatures, \`data-component\`, \`data-part\`, \`aria-*\`, and \`role\` attributes.
6. Prefer \`apps/web/src/styles/global.css\` for broad styling. Use page/layout class edits only when CSS selectors are not enough.
7. No new files unless strictly needed for styling.
8. No commits or PRs. The orchestrator handles commit and push.
9. A successful run must change at least one visible styling surface: \`apps/web/src/styles/global.css\`, \`apps/web/src/layouts/BaseLayout.astro\`, \`apps/web/src/pages/**\`, or \`apps/web/src/components/**\`.

# Before finishing

Inspect the changed pages mentally as a set: homepage, listing pagination, detail page, taxonomy pages, collections, comparisons, static page, 404, light mode, and dark mode. Fix obvious inconsistencies before stopping.

The user's customization request follows below.
`;
