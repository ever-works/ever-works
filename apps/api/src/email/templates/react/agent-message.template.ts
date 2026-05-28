/**
 * EW-650 / EW-668 / T16 — Agent-to-agent message email template.
 *
 * Used by the `messageAgent` tool descriptor (spec §12.4) to deliver
 * inter-agent messages as plain emails. Same dual `{ html, text }`
 * output shape as `agent-summary.template.ts`.
 */

import type { RenderedEmail } from './agent-summary.template.js';
export type { RenderedEmail } from './agent-summary.template.js';

export interface AgentMessageTemplateProps {
    readonly fromAgent: string;
    readonly toAgent: string;
    readonly subject: string;
    readonly body: string;
    readonly contextUrl?: string;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function renderAgentMessage(props: AgentMessageTemplateProps): RenderedEmail {
    const { fromAgent, toAgent, subject, body, contextUrl } = props;
    const safeFrom = escapeHtml(fromAgent);
    const safeTo = escapeHtml(toAgent);
    const safeSubject = escapeHtml(subject);
    const safeBody = escapeHtml(body).replace(/\n/g, '<br>');

    const ctaHtml = contextUrl
        ? `<p><a href="${escapeHtml(contextUrl)}" style="display:inline-block;padding:8px 14px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">Open in dashboard</a></p>`
        : '';
    const ctaText = contextUrl ? `\n\nOpen in dashboard: ${contextUrl}` : '';

    const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${safeSubject}</title></head>
  <body style="font-family: -apple-system, system-ui, sans-serif; color: #111; padding: 16px;">
    <p style="color:#888;font-size:12px;">From: <b>${safeFrom}</b> &nbsp;→&nbsp; To: <b>${safeTo}</b></p>
    <h3 style="margin:8px 0 14px;">${safeSubject}</h3>
    <div style="line-height:1.5;">${safeBody}</div>
    ${ctaHtml}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
    <p style="font-size:12px;color:#888;">Agent-to-agent message via Ever Works.</p>
  </body>
</html>`;

    const text = `From: ${fromAgent} → To: ${toAgent}
Subject: ${subject}

${body}${ctaText}

— Agent-to-agent message via Ever Works.`;

    return { html, text };
}
