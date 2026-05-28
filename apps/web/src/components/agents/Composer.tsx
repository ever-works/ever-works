'use client';

import { useState, useTransition } from 'react';
import {
    sendAgentEmailAction,
    type ComposeActionResult,
} from '@/app/[locale]/(dashboard)/agents/[id]/inbox/compose/actions';

interface Props {
    agentId: string;
}

/**
 * EW-680 / T32 — Inbox composer (v1: rich-text-free, plain subject/to/
 * cc/body). Submits via the sendAgentEmailAction server action. The
 * React-Email template picker is a v2 follow-up.
 */
export function Composer({ agentId }: Props) {
    const [to, setTo] = useState('');
    const [cc, setCc] = useState('');
    const [subject, setSubject] = useState('');
    const [bodyText, setBodyText] = useState('');
    const [result, setResult] = useState<ComposeActionResult | null>(null);
    const [isPending, startTransition] = useTransition();

    const onSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        startTransition(async () => {
            const res = await sendAgentEmailAction(agentId, { to, cc, subject, bodyText });
            setResult(res);
            if (res.ok) {
                setTo('');
                setCc('');
                setSubject('');
                setBodyText('');
            }
        });
    };

    return (
        <form onSubmit={onSubmit} className="space-y-4">
            <header className="flex items-center justify-between">
                <h1 className="text-2xl font-semibold">Compose</h1>
                <a href={`/agents/${agentId}/inbox`} className="text-sm text-muted-foreground">
                    ← Back to inbox
                </a>
            </header>

            {result?.ok ? (
                <div className="rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-800">
                    Sent ✓ (provider id: {result.providerMessageId})
                </div>
            ) : null}
            {result && !result.ok ? (
                <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                    {result.error}
                </div>
            ) : null}

            <div className="space-y-1">
                <label htmlFor="to" className="text-sm font-medium">
                    To
                </label>
                <input
                    id="to"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    placeholder="recipient@example.com, another@example.com"
                    className="w-full rounded-md border px-3 py-2 text-sm"
                />
            </div>

            <div className="space-y-1">
                <label htmlFor="cc" className="text-sm font-medium">
                    Cc <span className="text-muted-foreground">(optional)</span>
                </label>
                <input
                    id="cc"
                    value={cc}
                    onChange={(e) => setCc(e.target.value)}
                    className="w-full rounded-md border px-3 py-2 text-sm"
                />
            </div>

            <div className="space-y-1">
                <label htmlFor="subject" className="text-sm font-medium">
                    Subject
                </label>
                <input
                    id="subject"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className="w-full rounded-md border px-3 py-2 text-sm"
                />
            </div>

            <div className="space-y-1">
                <label htmlFor="body" className="text-sm font-medium">
                    Message
                </label>
                <textarea
                    id="body"
                    value={bodyText}
                    onChange={(e) => setBodyText(e.target.value)}
                    rows={12}
                    className="w-full rounded-md border px-3 py-2 text-sm"
                />
            </div>

            <button
                type="submit"
                disabled={isPending}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
                {isPending ? 'Sending…' : 'Send'}
            </button>
        </form>
    );
}
