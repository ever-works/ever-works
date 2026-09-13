import {
    ArrayMaxSize,
    IsArray,
    IsIn,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    WORK_REPO_DECLARED_COMMAND_MAX_ALLOW,
    WORK_REPO_DECLARED_COMMAND_MAX_LENGTH,
    WORK_REPO_DECLARED_COMMAND_MODES,
    type WorkRepoDeclaredCommandMode,
    type WorkRepoDeclaredCommandPolicy,
} from '@ever-works/contracts';

/**
 * The Work owner's decision about the commands their own repository
 * declares in `.works/works.yml` (EW-807).
 *
 * READ THE `mode` DESCRIPTION AS A WARNING, not as a setting. Turning this
 * to `allowlist` means the platform will execute commands written in a
 * repository file — on the owner's own enrolled machines, with their
 * shell, their Git credential helper, and (during a run) decrypted `.env`
 * files on disk. The author of that file is anyone who can land a commit
 * or a PR branch, and during a run it is also the model.
 *
 * That is why `allow` is an exact-match list and not a pattern, a prefix
 * or a program name: whatever an owner writes here is precisely what may
 * run, and nothing adjacent to it.
 *
 * AND WHY THAT IS STILL NOT ENOUGH ON ITS OWN. The list bounds the command
 * STRING, not the command's BEHAVIOUR, and the behaviour lives in files
 * the repository controls: `pnpm install` runs the repository's own
 * lifecycle scripts and honours a repository-committed `.npmrc`; `pnpm
 * test` runs whatever `package.json` puts behind `test` at the moment it
 * runs. Pass `--ignore-scripts`, prefer commands that do not dispatch
 * through a repository-authored script, and read the full account in
 * `repo-declared-commands.types.ts` before setting `mode` to `allowlist`.
 * (Repository-declared commands never receive the run's env grants, so an
 * install that needs a private-registry token belongs in the Work's own
 * setup defaults instead.)
 */
export class WorkRepoDeclaredCommandsDto implements WorkRepoDeclaredCommandPolicy {
    @ApiProperty({
        description:
            "off (the default for every Work): .works/works.yml is not consulted for commands at all. allowlist: the repository's spec.tasks.setup / spec.tasks.checks are read, and each declared command must appear VERBATIM in `allow` — a declared command is a command this Work's machines will run. The exact match bounds the command STRING, not what it does: an allow-listed `pnpm install` still runs the repository's own lifecycle scripts and its committed .npmrc, and an allow-listed `pnpm test` still runs whatever package.json puts behind `test`.",
        enum: WORK_REPO_DECLARED_COMMAND_MODES,
    })
    @IsIn(WORK_REPO_DECLARED_COMMAND_MODES)
    mode: WorkRepoDeclaredCommandMode;

    @ApiPropertyOptional({
        description:
            'Commands admitted verbatim. EXACT match after whitespace normalization — not a prefix, not a glob, not a program name: allowing "pnpm test" does not allow "pnpm test && curl …". Prefer commands that do not dispatch through repository-authored scripts (e.g. add --ignore-scripts to an install), because the match bounds the string and the repository still chooses the behaviour behind it.',
        type: [String],
        maxItems: WORK_REPO_DECLARED_COMMAND_MAX_ALLOW,
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(WORK_REPO_DECLARED_COMMAND_MAX_ALLOW)
    @IsString({ each: true })
    @MinLength(1, { each: true })
    @MaxLength(WORK_REPO_DECLARED_COMMAND_MAX_LENGTH, { each: true })
    allow: string[] = [];
}
