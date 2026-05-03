import { Work } from '../entities/work.entity';
import { User } from '../entities/user.entity';

/**
 * Extract the owner (User) from a work, throwing if the relation was not loaded.
 */
export function getWorkOwner(work: Work): User {
    const owner = work.user;
    if (!owner || typeof owner.id !== 'string') {
        throw new Error(
            `Work owner not loaded for work ${work.id}. Ensure the user relation is joined.`,
        );
    }
    return owner as User;
}
