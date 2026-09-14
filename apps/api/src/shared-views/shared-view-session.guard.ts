import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { SHARED_VIEW_NOT_ACTIVE } from '@ever-works/contracts/api';
import { SharedViewRepository, type SharedView } from '@ever-works/agent/shared-views';
import { readBearerSession, SharedViewSessionService } from './shared-view-session.service';

/** Where the guard leaves the resolved Shared view for the handler. */
export const SHARED_VIEW_KEY = 'sharedView';

/**
 * Admits a public share-link read only with a live view session.
 *
 * Verifies the MAC and expiry, then loads the view the session names and
 * requires it to be active AT THE SAME rotation count. So a session minted
 * before a regenerate, before sharing was turned off, or for a view since
 * deleted is refused on its very next request. Every refusal is the same
 * not-active `404`.
 */
@Injectable()
export class SharedViewSessionGuard implements CanActivate {
    constructor(
        private readonly sessions: SharedViewSessionService,
        private readonly views: SharedViewRepository,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<{
            headers?: Record<string, unknown>;
            [SHARED_VIEW_KEY]?: SharedView;
        }>();
        const claims = this.sessions.verify(readBearerSession(request.headers?.authorization));
        if (!claims) {
            throw new NotFoundException(SHARED_VIEW_NOT_ACTIVE);
        }
        const view = await this.views.findById(claims.sid);
        if (!view || view.status !== 'active' || view.rotationCount !== claims.rot) {
            throw new NotFoundException(SHARED_VIEW_NOT_ACTIVE);
        }
        request[SHARED_VIEW_KEY] = view;
        return true;
    }
}
