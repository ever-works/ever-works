'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';

interface SourceFieldsProps {
    sourceUrls: string[];
    onChange: (urls: string[]) => void;
}

export function SourceFields({ sourceUrls, onChange }: SourceFieldsProps) {
    const t = useTranslations('dashboard.directoryDetail.generator');
    const [newUrl, setNewUrl] = useState('');

    const addUrl = () => {
        if (!newUrl.trim()) return;

        try {
            new URL(newUrl);
            onChange([...sourceUrls, newUrl]);
            setNewUrl('');
        } catch {
            // Invalid URL - could show error
        }
    };

    const removeUrl = (index: number) => {
        onChange(sourceUrls.filter((_, i) => i !== index));
    };

    return (
        <div>
            <label className="block text-sm font-medium text-text dark:text-text-dark mb-1">
                {t('sourceUrls')}
            </label>
            <p className="text-xs text-text-muted dark:text-text-muted-dark mb-2">
                {t('sourceUrlsFieldDescription')}
            </p>
            <div className="flex gap-2 mb-3">
                <Input
                    type="url"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addUrl())}
                    placeholder={t('sourceUrlPlaceholder')}
                    variant="form"
                />
                <Button
                    type="button"
                    onClick={addUrl}
                    variant="secondary"
                    size="sm"
                    className="whitespace-nowrap"
                >
                    {t('addUrl')}
                </Button>
            </div>

            {sourceUrls.length === 0 ? (
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    {t('noSourceUrlsMessage')}
                </p>
            ) : (
                <div className="space-y-2">
                    {sourceUrls.map((url, index) => (
                        <div
                            key={index}
                            className={cn(
                                'flex items-center justify-between gap-2 p-2 rounded',
                                'bg-surface dark:bg-surface-dark',
                                'border border-border dark:border-border-dark',
                            )}
                        >
                            <a
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex-1 text-sm text-primary hover:underline truncate"
                            >
                                {url}
                            </a>
                            <button
                                type="button"
                                onClick={() => removeUrl(index)}
                                className="text-danger hover:text-danger/80"
                            >
                                <svg
                                    className="w-4 h-4"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M6 18L18 6M6 6l12 12"
                                    />
                                </svg>
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
