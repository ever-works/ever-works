import {
    Loader2,
    CheckCircle2,
    AlertTriangle,
    AlertCircle,
    XCircle,
    CircleDashed,
    type LucideIcon,
} from 'lucide-react';
import { GenerateStatusType } from '@/lib/api/enums';

export type GenerationStatusLabelKey =
    | 'generating'
    | 'generated'
    | 'generatedWithWarnings'
    | 'error'
    | 'cancelled'
    | 'notStarted';

export interface GenerationStatusConfig {
    icon: LucideIcon;
    animate: boolean;
    labelKey: GenerationStatusLabelKey;
    badge: string;
    card: {
        borderBg: string;
        iconBg: string;
        iconColor: string;
    };
    stat: {
        iconColor: string;
        bgColor: string;
    };
}

const STATUS_CONFIGS: Record<string, GenerationStatusConfig> = {
    [GenerateStatusType.GENERATING]: {
        icon: Loader2,
        animate: true,
        labelKey: 'generating',
        badge: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
        card: {
            borderBg: 'border-primary/20 dark:border-primary/30 bg-primary/5 dark:bg-primary/10',
            iconBg: 'bg-primary/10 dark:bg-primary/20',
            iconColor: 'text-primary',
        },
        stat: {
            iconColor: 'text-blue-600 dark:text-blue-400',
            bgColor: 'bg-blue-100 dark:bg-blue-900',
        },
    },
    [GenerateStatusType.GENERATED]: {
        icon: CheckCircle2,
        animate: false,
        labelKey: 'generated',
        badge: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
        card: {
            borderBg: 'border-success/20 dark:border-success/30 bg-success/5 dark:bg-success/10',
            iconBg: 'bg-success/10 dark:bg-success/20',
            iconColor: 'text-success',
        },
        stat: {
            iconColor: 'text-green-600 dark:text-green-400',
            bgColor: 'bg-green-100 dark:bg-green-900',
        },
    },
    GENERATED_WITH_WARNINGS: {
        icon: AlertTriangle,
        animate: false,
        labelKey: 'generatedWithWarnings',
        badge: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
        card: {
            borderBg:
                'border-amber-500/20 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-900/10',
            iconBg: 'bg-amber-100 dark:bg-amber-900/20',
            iconColor: 'text-amber-600 dark:text-amber-400',
        },
        stat: {
            iconColor: 'text-amber-600 dark:text-amber-400',
            bgColor: 'bg-amber-100 dark:bg-amber-900',
        },
    },
    [GenerateStatusType.ERROR]: {
        icon: AlertCircle,
        animate: false,
        labelKey: 'error',
        badge: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
        card: {
            borderBg: 'border-danger/20 dark:border-danger/30 bg-danger/5 dark:bg-danger/10',
            iconBg: 'bg-danger/10 dark:bg-danger/20',
            iconColor: 'text-danger',
        },
        stat: {
            iconColor: 'text-red-600 dark:text-red-400',
            bgColor: 'bg-red-100 dark:bg-red-900',
        },
    },
    [GenerateStatusType.CANCELLED]: {
        icon: XCircle,
        animate: false,
        labelKey: 'cancelled',
        badge: 'bg-gray-200 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
        card: {
            borderBg: 'border-border dark:border-border-dark bg-gray-50 dark:bg-gray-900/40',
            iconBg: 'bg-gray-200 dark:bg-gray-800',
            iconColor: 'text-gray-600 dark:text-gray-200',
        },
        stat: {
            iconColor: 'text-gray-600 dark:text-gray-400',
            bgColor: 'bg-gray-100 dark:bg-gray-900',
        },
    },
};

const NOT_STARTED_CONFIG: GenerationStatusConfig = {
    icon: CircleDashed,
    animate: false,
    labelKey: 'notStarted',
    badge: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
    card: {
        borderBg:
            'border-border dark:border-border-dark bg-surface-secondary/50 dark:bg-surface-secondary-dark/50',
        iconBg: 'bg-surface-tertiary dark:bg-surface-tertiary-dark',
        iconColor: 'text-text-muted dark:text-text-muted-dark',
    },
    stat: {
        iconColor: 'text-gray-600 dark:text-gray-400',
        bgColor: 'bg-gray-100 dark:bg-gray-900',
    },
};

export function getGenerationStatusConfig(
    status?: GenerateStatusType | null,
    options?: { hasWarnings?: boolean },
): GenerationStatusConfig {
    if (!status) return NOT_STARTED_CONFIG;

    if (status === GenerateStatusType.GENERATED && options?.hasWarnings) {
        return STATUS_CONFIGS['GENERATED_WITH_WARNINGS'];
    }

    return STATUS_CONFIGS[status] || NOT_STARTED_CONFIG;
}
