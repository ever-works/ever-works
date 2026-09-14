import type { FeedTargetDto } from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';

/**
 * Live Feed — map an entry's typed destination onto the web's own route
 * constants. The API only says WHAT an entry is about; where that lives in
 * the product is decided here, once. `null` means there is nothing to open
 * and the entry renders as plain text.
 */
export function feedTargetHref(target: FeedTargetDto | null | undefined): string | null {
    if (!target || !target.id) return null;
    const id = encodeURIComponent(target.id);
    switch (target.type) {
        case 'run':
            return ROUTES.DASHBOARD_AGENT_SESSION(id);
        case 'task':
            return ROUTES.DASHBOARD_TASK(id);
        case 'mission':
            return ROUTES.DASHBOARD_MISSION(id);
        case 'idea':
            return ROUTES.DASHBOARD_IDEA(id);
        case 'agent':
            return ROUTES.DASHBOARD_AGENT(id);
        case 'work':
            return ROUTES.DASHBOARD_WORK(id);
        case 'skill':
            return ROUTES.DASHBOARD_SKILL(id);
        case 'inbox':
            return `${ROUTES.DASHBOARD_INBOX}?id=${id}`;
        default:
            return null;
    }
}
