/**
 * EW-650 / EW-668 / T16 — Agent summary email template.
 *
 * Pure TypeScript template returning canonical `{ html, text }` shapes.
 * A v2 follow-up will swap the bodies to React-Email TSX rendered via
 * `@react-email/render` once the dep installs land — the registry +
 * facade integration in `render.ts` is already shaped for that swap.
 *
 * See `docs/specs/features/email-providers/spec.md` §11.1.
 */

export interface AgentSummaryTemplateProps {
    readonly agentName: string;
    readonly summary: string;
    readonly taskCount: number;
    readonly dashboardUrl: string;
}

export interface RenderedEmail {
    readonly html: string;
    readonly text: string;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function renderAgentSummary(props: AgentSummaryTemplateProps): RenderedEmail {
    const { agentName, summary, taskCount, dashboardUrl } = props;
    const safeName = escapeHtml(agentName);
    const safeSummary = escapeHtml(summary);
    const safeUrl = escapeHtml(dashboardUrl);

    const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${safeName} — daily summary</title></head>
  <body style="font-family: -apple-system, system-ui, sans-serif; color: #111; padding: 16px;">
    <h2>${safeName}</h2>
    <p style="color: #444;">Daily summary · ${taskCount} task${taskCount === 1 ? '' : 's'} processed</p>
    <p>${safeSummary}</p>
    <p><a href="${safeUrl}" style="display:inline-block;padding:8px 14px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">Open dashboard</a></p>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
    <p style="font-size:12px;color:#888;">Sent by Ever Works on behalf of ${safeName}.</p>
  </body>
</html>`;

    const text = `${agentName}
Daily summary · ${taskCount} task${taskCount === 1 ? '' : 's'} processed

${summary}

Open dashboard: ${dashboardUrl}

— Sent by Ever Works on behalf of ${agentName}.`;

    return { html, text };
}
