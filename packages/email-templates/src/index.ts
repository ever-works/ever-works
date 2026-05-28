/**
 * @ever-works/email-templates — server-side React-Email templates + a
 * slug-based renderer (EW-650 / EW-668).
 *
 * All React/JSX is isolated to this package so the NestJS API + agent
 * packages stay React-free; consumers import `renderTemplate()` which
 * returns plain `{ html, text }` strings.
 */
export { renderTemplate, listTemplates } from './render.js';
export type { RenderedEmail, AgentSummaryTemplateProps, AgentMessageTemplateProps } from './render.js';
export { AgentSummaryEmail } from './components/agent-summary.js';
export { AgentMessageEmail } from './components/agent-message.js';
