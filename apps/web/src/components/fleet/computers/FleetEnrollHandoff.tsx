'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Copy, Download, ExternalLink, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CreateFleetEnrollmentTokenResponse } from '@/lib/api/fleet';
import { FleetQrCode } from './FleetQrCode';

interface FleetEnrollHandoffProps {
    issued: CreateFleetEnrollmentTokenResponse;
    /** Public API base the node will call (no trailing `/api`). */
    apiBaseUrl: string;
    /** Where the desktop node app is downloaded from. */
    desktopDownloadUrl: string;
    /** Where the headless node app is downloaded from. */
    nodeDownloadUrl: string;
}

/**
 * Everything needed to get a one-time token ONTO the target machine
 * without anyone retyping 43 characters of base64url:
 *
 *   - the token itself, with a copy button (as before);
 *   - the ready-to-run CLI command, with its own copy button;
 *   - a QR of that command, for the very common case where the machine
 *     you are standing at is not the machine you are logged in on;
 *   - a downloadable handoff file, for moving it to a box with no
 *     clipboard between you and it;
 *   - links to actually download the node apps.
 *
 * The token is never persisted anywhere by this component: the download
 * is built in memory, handed to the browser, and the object URL is
 * revoked immediately. Closing the dialog drops the token for good —
 * the server only ever stored its hash.
 */
export function FleetEnrollHandoff({
    issued,
    apiBaseUrl,
    desktopDownloadUrl,
    nodeDownloadUrl,
}: FleetEnrollHandoffProps) {
    const t = useTranslations('dashboard.settings.fleet');
    const [copied, setCopied] = useState<'token' | 'command' | null>(null);

    // The node CLI wants the API ORIGIN, not the `/api` prefix the web
    // tier talks to, so a deployment whose public URL already carries it
    // does not produce `…/api/api/fleet/enroll`.
    const normalizedApiUrl = apiBaseUrl.replace(/\/+$/, '').replace(/\/api$/, '');
    const command = `ever-works-node enroll --api-url ${normalizedApiUrl} --token ${issued.token}`;

    const copy = async (value: string, which: 'token' | 'command') => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(which);
            setTimeout(() => setCopied(null), 2000);
        } catch {
            toast.error(t('add.copyError'));
        }
    };

    const downloadHandoffFile = () => {
        const payload = {
            apiUrl: normalizedApiUrl,
            token: issued.token,
            nodeId: issued.node.id,
            name: issued.node.name,
            kind: issued.node.kind,
            expiresInSec: issued.expiresInSec,
            command,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
            type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        try {
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `ever-works-node-enrollment-${issued.node.id}.json`;
            anchor.click();
        } finally {
            // Do not leave a blob holding a live credential in memory.
            URL.revokeObjectURL(url);
        }
    };

    return (
        <div className="space-y-4" data-testid="fleet-enroll-handoff">
            <p className="text-sm text-text dark:text-text-dark">
                {t('add.tokenIntro', { minutes: Math.round(issued.expiresInSec / 60) })}
            </p>

            <div className="flex items-center gap-2">
                <code
                    className="flex-1 px-3 py-2 rounded-lg border border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/40 text-sm break-all select-all"
                    data-testid="fleet-enroll-token"
                >
                    {issued.token}
                </code>
                <Button
                    variant="secondary"
                    onClick={() => copy(issued.token, 'token')}
                    data-testid="fleet-copy-token"
                >
                    <Copy className="w-4 h-4" />
                    {copied === 'token' ? t('add.copied') : t('add.copy')}
                </Button>
            </div>

            <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-start">
                <div className="space-y-1.5">
                    <FleetQrCode
                        value={command}
                        label={t('handoff.qrLabel')}
                        data-testid="fleet-enroll-qr"
                    />
                    <p className="text-xs text-center text-text-muted dark:text-text-muted-dark max-w-[168px]">
                        {t('handoff.qrHint')}
                    </p>
                </div>

                <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-sm font-medium text-text dark:text-text-dark">
                        <Terminal className="w-4 h-4" />
                        {t('handoff.commandTitle')}
                    </div>
                    <code
                        className="block px-3 py-2 rounded-lg border border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/40 text-xs break-all select-all"
                        data-testid="fleet-enroll-command"
                    >
                        {command}
                    </code>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            variant="secondary"
                            onClick={() => copy(command, 'command')}
                            data-testid="fleet-copy-command"
                        >
                            <Copy className="w-4 h-4" />
                            {copied === 'command' ? t('add.copied') : t('handoff.copyCommand')}
                        </Button>
                        <Button
                            variant="secondary"
                            onClick={downloadHandoffFile}
                            data-testid="fleet-download-handoff"
                        >
                            <Download className="w-4 h-4" />
                            {t('handoff.downloadFile')}
                        </Button>
                    </div>
                </div>
            </div>

            <div className="p-3 rounded-lg bg-info/10 border border-info/20 space-y-2">
                <p className="text-sm font-medium text-text dark:text-text-dark">
                    {t('handoff.downloadsTitle')}
                </p>
                <div className="flex flex-wrap gap-3 text-sm">
                    <a
                        href={desktopDownloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-info hover:underline"
                        data-testid="fleet-download-desktop"
                    >
                        {t('handoff.downloadDesktop')}
                        <ExternalLink className="w-3 h-3" />
                    </a>
                    <a
                        href={nodeDownloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-info hover:underline"
                        data-testid="fleet-download-node"
                    >
                        {t('handoff.downloadNode')}
                        <ExternalLink className="w-3 h-3" />
                    </a>
                </div>
            </div>

            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                {t('add.tokenOnce')}
            </p>
        </div>
    );
}
