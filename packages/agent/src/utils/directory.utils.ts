import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';

/**
 * Extract the owner (User) from a directory, throwing if the relation was not loaded.
 */
export function getDirectoryOwner(directory: Directory): User {
    const owner = directory.user;
    if (!owner || typeof owner.id !== 'string') {
        throw new Error(
            `Directory owner not loaded for directory ${directory.id}. Ensure the user relation is joined.`,
        );
    }
    return owner as User;
}
