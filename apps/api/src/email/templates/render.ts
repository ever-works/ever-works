/**
 * EW-650 / EW-668 — Email template registry.
 *
 * Thin re-export of `@ever-works/email-templates`, which holds the real
 * React-Email (`@react-email/components` + `@react-email/render`) `.tsx`
 * templates. All JSX is isolated to that package so this SWC-built
 * NestJS app stays React-free; `renderTemplate()` returns plain
 * `{ html, text }` strings. See spec §11.1.
 */
export { renderTemplate, listTemplates } from '@ever-works/email-templates';
export type {
    RenderedEmail,
    AgentSummaryTemplateProps,
    AgentMessageTemplateProps,
} from '@ever-works/email-templates';
