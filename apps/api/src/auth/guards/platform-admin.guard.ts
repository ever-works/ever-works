import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
} from '@nestjs/common';
import { UserRepository } from '@ever-works/agent/database';
import type { AuthenticatedUser } from '../types/auth.types';

/**
 * EW-602 — Guards routes that are only accessible to the self-hosted
 * platform owner. Loads the User row by `auth.userId` and 403s unless
 * `User.isPlatformAdmin === true`.
 *
 * Composes after AuthSessionGuard (the global guard), so we know
 * `request.user` is already populated.
 */
@Injectable()
export class IsPlatformAdminGuard implements CanActivate {
    constructor(private readonly userRepository: UserRepository) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
        const auth = request.user;
        if (!auth?.userId) {
            throw new ForbiddenException('Authentication required for admin routes');
        }
        const user = await this.userRepository.findById(auth.userId);
        if (!user?.isPlatformAdmin) {
            throw new ForbiddenException('Platform admin access required');
        }
        return true;
    }
}
