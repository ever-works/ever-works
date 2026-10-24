/**
 * Servers and ports, phase 2 (FL-10, spec §5.4) — the preview host's own
 * pages: plain HTML, no script, every interpolated value escaped. They are
 * the only thing the preview host ever serves that is not the tunnelled
 * server's own answer.
 */

export type PreviewHostPage = 'notFound' | 'ended' | 'notYours' | 'signIn' | 'nodeDidNotAnswer' | 'timeout' | 'redirect';

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const COPY: Readonly<Record<PreviewHostPage, { status: number; title: string; body: string }>> = {
    notFound: { status: 404, title: 'Not found', body: 'There is no preview at this address.' },
    ended: {
        status: 410,
        title: 'This preview has ended',
        body: "This preview has ended. Open it again from {computer}'s Ports tab.",
    },
    notYours: { status: 403, title: 'Not yours', body: 'This preview belongs to someone else.' },
    signIn: {
        status: 401,
        title: 'Open it from Ever Works',
        body: "This link has expired or was already used. Sign in to Ever Works and choose Preview in my browser again on {computer}'s Ports tab.",
    },
    nodeDidNotAnswer: {
        status: 502,
        title: 'No answer',
        body: '{computer} did not answer. The server may have stopped.',
    },
    timeout: {
        status: 504,
        title: 'No answer in time',
        body: '{computer} did not answer within 60 seconds.',
    },
    redirect: {
        status: 200,
        title: 'Leaving the preview',
        body: 'The page wants to go to another address, which a preview does not follow:',
    },
};

/** A page and its status. `computer` names the machine where the copy does. */
export function renderPreviewHostPage(
    page: PreviewHostPage,
    options: { computer?: string; link?: string } = {},
): { status: number; html: string } {
    const copy = COPY[page];
    const computer = escapeHtml(options.computer ?? 'the computer');
    const body = escapeHtml(copy.body).replace(/\{computer\}/g, computer);
    const link =
        options.link && /^https?:\/\//i.test(options.link)
            ? `<p><a href="${escapeHtml(options.link)}" rel="noopener noreferrer">${escapeHtml(options.link)}</a></p>`
            : '';
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(
        copy.title,
    )} · Ever Works preview</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f7f8;color:#1d1d1f}main{max-width:32rem;padding:2rem}h1{font-size:1.25rem}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}a{color:#8ab4ff}}</style></head><body><main><h1>${escapeHtml(
        copy.title,
    )}</h1><p>${body}</p>${link}</main></body></html>`;
    return { status: copy.status, html };
}
