import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
    Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RailRefusalService } from '@ever-works/agent/safety';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { HUMAN_ONLY_KEY } from '../decorators/human-only.decorator';

/**
 * Safety rails (AW-24) — "a person, in an interactive session".
 *
 * Applied to the writes that FR-31 and FR-47 reserve for a human: a rung
 * change, and (in P3) a workspace pause or resume. Everything else on the
 * safety surface is a read and is unaffected.
 *
 * ## Fail closed on a missing stamp
 *
 * `AuthSessionGuard` stamps `authMethod` in both of its branches. A request
 * that carries no stamp at all took a path this guard does not know about,
 * and the safe reading of "I cannot tell whether this is a person" is NOT a
 * person. A guard that admitted the unknown case would be satisfied by
 * exactly the credential path it exists to refuse.
 *
 * ## The refusal is recorded
 *
 * A machine trying to move a rung or lift a pause is a signal worth reading,
 * so it becomes a `rail_refusals` row with the `non-human-actor` reason
 * rather than a 403 that disappears into an access log. Recording is
 * best-effort by contract (`RailRefusalService.record()` never throws): the
 * refusal stands whether or not the row could be written.
 */
@Injectable()
export class HumanActorGuard implements CanActivate {
    private readonly logger = new Logger(HumanActorGuard.name);

    constructor(
        private readonly reflector: Reflector,
        private readonly refusals: RailRefusalService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        if (context.getType() !== 'http') return true;

        const humanOnly = this.reflector.getAllAndOverride<boolean>(HUMAN_ONLY_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (!humanOnly) return true;

        const request = context.switchToHttp().getRequest();
        const user = request.user as AuthenticatedUser | undefined;
        if (user?.authMethod === 'session') return true;

        this.logger.warn(
            `Safety: a non-human actor (${user?.authMethod ?? 'unknown credential path'}) tried ` +
                `to change safety settings for user ${user?.userId ?? 'anonymous'} — refused.`,
        );
        if (user?.userId) {
            await this.refusals.record({
                userId: user.userId,
                railId: 'ladder',
                verdict: 'refused',
                reasonCode: 'non-human-actor',
                subjectType: 'agent',
                subjectId: null,
                summary:
                    'Only a person signed in to the workspace can change safety settings. ' +
                    'An API key or automation asked to, and was refused.',
                requested: { authMethod: user.authMethod ?? 'unknown' },
            });
        }

        throw new ForbiddenException(
            'Only a person signed in to this workspace can change safety settings.',
        );
    }
}
