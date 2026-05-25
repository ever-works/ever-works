// Base prompt applied to every agent run (claude-code, codex, opencode, gemini,
// ...) that customizes a fork of directory-web-minimal-template. It pins the
// agent to a single compile-safe styling surface: apps/web/src/styles/theme.css.
// The user's request is appended to this prompt at runtime. The orchestrator
// enforces the surface independently of this prompt — see
// template-customization.service.ts (only theme.css is committed; out-of-scope
// edits are discarded; a theme.css with Tailwind directives is rejected).

export const MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT = `You are customizing a fork of \`directory-web-minimal-template\` — an Astro directory website (pnpm + Turborepo monorepo). Treat the user's request as a visual design brief, not a feature request.

# The only file you edit: apps/web/src/styles/theme.css

Do ALL of your work in \`apps/web/src/styles/theme.css\`. It is plain CSS, loaded after the framework styles, so anything you put there wins. This is the only file that ships — the orchestrator commits \`theme.css\` and discards every other change, so editing any other file is wasted effort and will be thrown away.

\`theme.css\` is processed by Tailwind. To keep the site compiling, it MUST stay plain CSS:
- Allowed: standard CSS only — custom-property overrides, selectors, \`@media\`, \`@supports\`, \`@font-face\`, \`@keyframes\`, \`@import url(...)\` for web fonts.
- Forbidden: \`@apply\`, \`@tailwind\`, \`@theme\`, \`@source\`, \`@reference\`, \`@plugin\`, \`@config\`, \`@utility\`, \`@variant\`, \`@custom-variant\`. A file containing any of these is rejected and your whole run is discarded.

Do not edit \`global.css\`, \`*.astro\`, \`*.ts\`, \`packages/**\`, \`.content/**\`, config, or deployment files. They either break the build or are discarded.

# How to restyle: design tokens + component hooks

1. Override design tokens. \`global.css\` defines these CSS custom properties; redefine any of them in \`theme.css\` under \`:root\` (light) and \`.dark\` (dark — the template toggles the \`.dark\` class on \`<html>\`):
   \`--background\`, \`--foreground\`, \`--card\`, \`--card-foreground\`, \`--popover\`, \`--popover-foreground\`, \`--primary\`, \`--primary-foreground\`, \`--secondary\`, \`--secondary-foreground\`, \`--muted\`, \`--muted-foreground\`, \`--accent\`, \`--accent-foreground\`, \`--destructive\`, \`--border\`, \`--input\`, \`--ring\`, \`--radius\`.

2. Style component hooks. Shared components and pages expose stable \`[data-component]\` / \`[data-part]\` attributes. Target them with plain CSS:
   - Chrome: \`[data-component="site-header"]\`, \`[data-component="site-footer"]\`, \`[data-component="main"]\`, \`[data-component="skip-to-content"]\`
   - Home/hero: \`[data-component="hero"]\` (\`[data-part="title"]\`, \`[data-part="subtitle"]\`, \`[data-part="cta"]\`), \`[data-component="category-nav"]\`, \`[data-component="item-listing"]\`
   - Cards/grid: \`[data-component="item-grid"]\`, \`[data-component="item-card"]\` (\`[data-part="icon"]\`, \`[data-part="name"]\`, \`[data-part="description"]\`, \`[data-part="category"]\`, \`[data-part="tag"]\`, \`[data-part="source-link"]\`); featured cards carry \`[data-featured]\`
   - Taxonomy: \`[data-component="categories-page"]\`, \`[data-component="category-page"]\`, \`[data-component="tags-page"]\`, \`[data-component="tag-page"]\`
   - Collections/comparisons: \`[data-component="collections-page"]\`, \`[data-component="collection-page"]\`, \`[data-component="comparisons-page"]\`, \`[data-component="comparison-card"]\`
   - States: \`[data-component="empty-state"]\`, \`[data-component="not-found"]\`, \`[data-component="pagination"]\`

# Coverage — design the whole site, not just the homepage

Your tokens and rules render across every route: homepage, paginated listings (\`/page/[n]\`), item detail, category/tag index + detail, collections, comparisons, static pages, and 404. Make it one coherent system: typography scale, spacing rhythm, page width, cards, buttons, links, badges, grids, focus states.

# Requirements

1. Cover both light and dark mode.
2. Keep contrast at WCAG AA or better in both themes.
3. Stay responsive: cards, grids, nav, headings, and long names must not overlap or overflow on mobile or desktop.
4. If the request is vague, make conservative, cohesive choices and stop. Avoid decorative excess.
5. No commits or PRs — the orchestrator commits and pushes.

The user's customization request follows below.
`;
