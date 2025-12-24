import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';

export function PrUpdateInfo({
    mainPR,
    dataPR,
    className,
}: {
    mainPR: any;
    dataPR: any;
    className?: string;
}) {
    const tConf = useTranslations('dashboard.directoryDetail.config');

    if (!mainPR?.url && !dataPR?.url) {
        return null;
    }

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
                        href={mainPR?.url || '#'}
                        target="_blank"
                        variant="unstyled"
                        rel="noopener noreferrer"
                        className={cn(
                            'text-sm',
                            mainPR?.url && 'text-primary hover:underline font-mono',
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
                        href={dataPR?.url}
                        target="_blank"
                        variant="unstyled"
                        rel="noopener noreferrer"
                        className={cn(
                            'text-sm',
                            dataPR?.url && 'text-primary hover:underline font-mono',
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
