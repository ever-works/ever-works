import type { AppEnvActorNames } from './app-env.service';

/**
 * APW-07 (lane aw-builds-bindings, 2026-10-27) — `APP_ENV_ACTOR_NAMES`: the "Set · by Maya" of
 * the Environment table (plan §3.3:293, S3).
 *
 * The provisional swap the port's declaration names was `useExisting: WorkMemberService`, which
 * has no `nameOf`; this adapter is the narrow read instead, over the three repositories it needs,
 * each resolved LAZILY (the module's `ModuleRef` pattern), so `AppEnvModule` keeps compiling
 * standalone and an unbound repository answers `null` — exactly what the unbound port answered.
 *
 * ## Whose name, and which name
 *
 * - Only a person with a relationship to THIS Work is named: its owner, or one of its members.
 *   An env row's `setByUserId` that is neither (a member who has since left) answers `null`, so
 *   the table never names a stranger, and a caller cannot use the port to look anybody up.
 * - The display name, else the username — never the email address, which the Environment table
 *   has no business showing to every member.
 */

/** The reads this adapter makes, as narrow views (structural, so a spec passes plain objects). */
export interface AppEnvActorNameSources {
    works(): { findById(id: string): Promise<{ userId?: string | null } | null> } | undefined;
    members(): { findMember(workId: string, userId: string): Promise<unknown | null> } | undefined;
    users():
        | {
              findById(
                  id: string,
              ): Promise<{ displayName?: string | null; username?: string | null } | null>;
          }
        | undefined;
}

/** At most this many characters of a name are returned (a row cell, not a profile). */
const APP_ENV_ACTOR_NAME_MAX = 80;

export function appEnvActorNames(sources: AppEnvActorNameSources): AppEnvActorNames {
    return {
        nameOf: async (workId: string, userId: string): Promise<string | null> => {
            if (!workId || !userId) return null;
            const works = sources.works();
            const users = sources.users();
            if (!works || !users) return null;

            const work = await works.findById(workId);
            if (!work) return null;
            if (work.userId !== userId) {
                const member = await sources.members()?.findMember(workId, userId);
                if (!member) return null;
            }

            const user = await users.findById(userId);
            const name = (user?.displayName ?? '').trim() || (user?.username ?? '').trim();
            return name ? name.slice(0, APP_ENV_ACTOR_NAME_MAX) : null;
        },
    };
}
