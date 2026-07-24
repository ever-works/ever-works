import {
    BarChart3,
    Building2,
    Clock,
    FileText,
    Files,
    ListChecks,
    Package,
    Rocket,
    Scale,
    Tag,
    Tags,
    Target,
    UserPlus,
    Users,
    Bot,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { WorkMetricId } from '@ever-works/contracts';

/**
 * Icon + accent colour per metric.
 *
 * `@ever-works/contracts` is framework-free — it cannot hold React
 * components — so the metric *definitions* live there and their
 * *presentation* lives here. Keep this map exhaustive over `WorkMetricId`;
 * TypeScript enforces that.
 */
export const WORK_METRIC_PRESENTATION: Record<
    WorkMetricId,
    { icon: LucideIcon; iconColor: string }
> = {
    'total-items': { icon: Package, iconColor: 'text-blue-500' },
    posts: { icon: FileText, iconColor: 'text-blue-500' },
    categories: { icon: Tag, iconColor: 'text-violet-500' },
    tags: { icon: Tags, iconColor: 'text-violet-500' },
    comparisons: { icon: Scale, iconColor: 'text-emerald-500' },
    'generation-status': { icon: Rocket, iconColor: 'text-sky-500' },
    'deploy-status': { icon: Rocket, iconColor: 'text-emerald-500' },
    'days-active': { icon: Clock, iconColor: 'text-orange-500' },
    'registered-users': { icon: UserPlus, iconColor: 'text-teal-500' },
    'team-members': { icon: Users, iconColor: 'text-purple-500' },
    agents: { icon: Bot, iconColor: 'text-indigo-500' },
    'open-tasks': { icon: ListChecks, iconColor: 'text-amber-500' },
    'works-owned': { icon: Building2, iconColor: 'text-cyan-500' },
    'page-views': { icon: BarChart3, iconColor: 'text-blue-500' },
    sessions: { icon: Target, iconColor: 'text-fuchsia-500' },
    conversions: { icon: Files, iconColor: 'text-rose-500' },
};
