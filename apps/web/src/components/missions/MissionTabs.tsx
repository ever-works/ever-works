'use client';

import { Link, usePathname } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';

/**
 * Mission tab strip — Tasks Phase 14.4 scaffold.
 *
 * v1 surfaces Overview + Tasks tabs. The existing Mission detail
 * page (`missions/[id]/page.tsx`) is the Overview content; the
 * Tasks tab routes to `/missions/[id]/tasks` (Phase 14 partial).
 *
 * Wiring this strip into the actual `/missions/[id]/layout.tsx`
 * is intentionally deferred — the existing single-column body is
 * stable, and dropping the strip above it touches the work-proposals
 * relationship UI. Component is here so the per-target route can
 * link to it, and the layout migration is a one-line follow-up.
 *
 * (When the layout migration lands, mount this component above the
 * children in `missions/[id]/layout.tsx`.)
 */
const TABS = [
	{ key: 'overview' as const, label: 'Overview', route: (id: string) => ROUTES.DASHBOARD_MISSION(id) },
	{
		key: 'tasks' as const,
		label: 'Tasks',
		route: (id: string) => `${ROUTES.DASHBOARD_MISSION(id)}/tasks`,
	},
];

export function MissionTabs({ missionId }: { missionId: string }) {
	const pathname = usePathname() ?? '';
	const overviewPath = ROUTES.DASHBOARD_MISSION(missionId);
	const tasksPath = `${overviewPath}/tasks`;

	return (
		<nav className="border-b border-border/60 dark:border-border-dark/60 px-6">
			<ul className="flex items-center gap-1 overflow-x-auto">
				{TABS.map((tab) => {
					const href = tab.route(missionId);
					const isActive =
						tab.key === 'overview' ? pathname.endsWith(overviewPath) : pathname.endsWith(tasksPath);
					return (
						<li key={tab.key}>
							<Link
								href={href}
								className={cn(
									'inline-flex items-center px-3 h-10 text-sm border-b-2 transition-colors',
									isActive
										? 'border-primary text-text dark:text-text-dark'
										: 'border-transparent text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark',
								)}
							>
								{tab.label}
							</Link>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}
