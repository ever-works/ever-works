'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { ChevronDown, Search, Loader2 } from 'lucide-react';
import { fetchModels } from '@/app/actions/plugins';

interface AiModel {
    id: string;
    name: string;
    description?: string;
    capabilities: {
        maxContextLength: number;
        maxOutputTokens?: number;
    };
    inputCostPer1k?: number;
    outputCostPer1k?: number;
}

interface PluginModelSelectProps {
    pluginId: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
}

export function PluginModelSelect({
    pluginId,
    value,
    onChange,
    disabled = false,
}: PluginModelSelectProps) {
    const t = useTranslations('dashboard.plugins.modelSelect');
    const [models, setModels] = useState<AiModel[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [customModel, setCustomModel] = useState('');
    const [showCustomInput, setShowCustomInput] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Click-outside detection via document listener (replaces fragile z-index overlay)
    const handleClickOutside = useCallback((e: MouseEvent) => {
        if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
            setIsOpen(false);
            setSearch('');
        }
    }, []);

    useEffect(() => {
        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
            return () => document.removeEventListener('mousedown', handleClickOutside);
        }
    }, [isOpen, handleClickOutside]);

    useEffect(() => {
        if (!pluginId) return;

        setLoading(true);
        setError(null);
        fetchModels(pluginId)
            .then((data) => {
                setModels(Array.isArray(data) ? data : []);
            })
            .catch(() => {
                setError(t('loadError'));
            })
            .finally(() => {
                setLoading(false);
            });
    }, [pluginId, t]);

    const filteredModels = useMemo(() => {
        if (!search) return models;
        const searchLower = search.toLowerCase();
        return models.filter(
            (m) =>
                m.id.toLowerCase().includes(searchLower) ||
                m.name.toLowerCase().includes(searchLower),
        );
    }, [models, search]);

    const selectedModel = models.find((m) => m.id === value);
    const displayValue = selectedModel?.name || selectedModel?.id || value || t('placeholder');

    const formatContext = (tokens: number) => {
        if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(0)}M`;
        if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}K`;
        return String(tokens);
    };

    const handleSelect = (modelId: string) => {
        onChange(modelId);
        setIsOpen(false);
        setSearch('');
    };

    const handleCustomSubmit = () => {
        if (customModel.trim()) {
            onChange(customModel.trim());
            setCustomModel('');
            setShowCustomInput(false);
            setIsOpen(false);
        }
    };

    return (
        <div ref={containerRef} className="relative">
            {/* Trigger button */}
            <button
                type="button"
                disabled={disabled}
                onClick={() => setIsOpen(!isOpen)}
                className={cn(
                    'w-full px-3 py-2 rounded-lg border border-border dark:border-border-dark',
                    'bg-surface-secondary dark:bg-surface-secondary-dark',
                    'text-text dark:text-text-dark text-left text-sm',
                    'focus:outline-none focus:ring-2 focus:ring-primary/50',
                    'flex items-center justify-between gap-2',
                    disabled && 'opacity-50 cursor-not-allowed',
                )}
            >
                <span className={cn(!value && 'text-text-muted dark:text-text-muted-dark')}>
                    {loading ? t('loading') : displayValue}
                </span>
                {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin text-text-muted" />
                ) : (
                    <ChevronDown className="w-4 h-4 text-text-muted" />
                )}
            </button>

            {/* Dropdown */}
            {isOpen && !disabled && (
                <div className="absolute z-50 mt-1 w-full rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark shadow-lg max-h-80 overflow-hidden">
                    {/* Search input */}
                    <div className="p-2 border-b border-border dark:border-border-dark">
                        <div className="relative">
                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder={t('searchPlaceholder')}
                                className={cn(
                                    'w-full pl-8 pr-3 py-1.5 text-sm rounded-md',
                                    'bg-surface-secondary dark:bg-surface-secondary-dark',
                                    'text-text dark:text-text-dark',
                                    'border border-border dark:border-border-dark',
                                    'focus:outline-none focus:ring-1 focus:ring-primary/50',
                                )}
                                autoFocus
                            />
                        </div>
                    </div>

                    {/* Model list */}
                    <div className="overflow-y-auto max-h-56">
                        {error && <div className="px-3 py-2 text-sm text-danger">{error}</div>}

                        {!error && filteredModels.length === 0 && !loading && (
                            <div className="px-3 py-2 text-sm text-text-muted dark:text-text-muted-dark">
                                {t('noModels')}
                            </div>
                        )}

                        {filteredModels.map((model) => (
                            <button
                                key={model.id}
                                type="button"
                                onClick={() => handleSelect(model.id)}
                                className={cn(
                                    'w-full px-3 py-2 text-left text-sm',
                                    'hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark',
                                    model.id === value && 'bg-primary/10 text-primary',
                                )}
                            >
                                <div className="flex items-center justify-between">
                                    <span className="font-medium truncate">
                                        {model.name || model.id}
                                    </span>
                                    {model.capabilities?.maxContextLength && (
                                        <span className="text-xs text-text-muted dark:text-text-muted-dark ml-2 shrink-0">
                                            {t('context', {
                                                value: formatContext(
                                                    model.capabilities.maxContextLength,
                                                ),
                                            })}
                                        </span>
                                    )}
                                </div>
                                {model.id !== model.name && (
                                    <div className="text-xs text-text-muted dark:text-text-muted-dark truncate">
                                        {model.id}
                                    </div>
                                )}
                            </button>
                        ))}
                    </div>

                    {/* Custom model input */}
                    <div className="border-t border-border dark:border-border-dark p-2">
                        {showCustomInput ? (
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={customModel}
                                    onChange={(e) => setCustomModel(e.target.value)}
                                    placeholder={t('customModelPlaceholder')}
                                    className={cn(
                                        'flex-1 px-2 py-1 text-sm rounded-md',
                                        'bg-surface-secondary dark:bg-surface-secondary-dark',
                                        'text-text dark:text-text-dark',
                                        'border border-border dark:border-border-dark',
                                        'focus:outline-none focus:ring-1 focus:ring-primary/50',
                                    )}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            handleCustomSubmit();
                                        }
                                        if (e.key === 'Escape') setShowCustomInput(false);
                                    }}
                                    autoFocus
                                />
                                <button
                                    type="button"
                                    onClick={handleCustomSubmit}
                                    className="px-3 py-1 text-sm bg-primary text-white rounded-md hover:bg-primary/90"
                                >
                                    {t('add')}
                                </button>
                            </div>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setShowCustomInput(true)}
                                className="w-full text-left text-sm text-primary hover:text-primary/80 px-1 py-0.5"
                            >
                                {t('addCustomModel')}
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
