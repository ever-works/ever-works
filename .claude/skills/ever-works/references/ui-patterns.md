# Ever Works — UI & design patterns

Canonical design guidance across the Ever Works web surfaces — the platform (`ever-works/ever-works` → `apps/web`) and the open-source `directory-web-template` (and every customer site forked from it). These are the rules; per-repo CSS is just the local expression.

## Primary CTA — light vs dark mode
- **Light mode:** solid theme-primary fill (brand colour), white text.
- **Dark mode:** white background, near-black text (`dark:bg-white dark:text-gray-900`) — NOT the brand colour inverted.

```tsx
<button className="bg-primary text-white dark:bg-white dark:text-gray-900">
  Get started
</button>
```
Why: the brand colour at full saturation on a near-black canvas reads as a coloured rectangle rather than a clear action target. White-on-dark gives the CTA the same visual weight as the light-mode pattern without competing with content. Applies to primary CTAs (template hero "Get started", category "Browse all", item "Visit"; the platform's onboarding CTAs). Secondary/icon/link buttons follow normal theme rules.

## Stats / KPI cards — monochrome
KPI tiles use ONE neutral icon-and-value colour (default text on card background). Do NOT colour the value/icon by "good vs bad" status (red/amber/green).

```tsx
// ✅ monochrome KPI
<KPICard label="Active users" value={1284} />
// ❌ don't colour the value by health
<KPICard label="Failed runs" value={42} className="text-red-600" />
// ✅ status colour belongs on the row badge of the underlying table
<StatusBadge state="failing" />
```
Why: a KPI grid with mixed red/amber/green reads as an alert dashboard, not a summary — each tile competes for attention. Reserve colour for row-level status in the table the KPI summarises; keep the KPI grid calm.

## Applying patterns in code
Prefer composing tokens (e.g. a `primaryCta` variant on a shared `Button`) over per-page inline classes — keeps each pattern auditable in one place per repo. Components live in `apps/web/src/components/` (platform) and `src/components/` (template). Design changes are additive by default — a new pattern must not silently drop existing surfaces.
