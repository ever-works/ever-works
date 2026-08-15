// Public surface of the agent-side Skills module
// (Agents/Skills/Tasks PR #1017 — Phase 8 + 9).
export * from './skills.module';
export * from './skills.service';
export * from './skill-files.service';
export * from './skill-invocation';
export { Skill, type SkillOwnerType, type SkillFrontmatter } from '../entities/skill.entity';
export { SkillBinding, type SkillBindingTargetType } from '../entities/skill-binding.entity';
export { SkillFile, SKILL_FILE_KINDS, type SkillFileKind } from '../entities/skill-file.entity';
export { SkillRepository, type ListSkillsFilter } from '../database/repositories/skill.repository';
export { SkillFileRepository } from '../database/repositories/skill-file.repository';
export {
    SkillBindingRepository,
    type ResolvedSkill,
    type ResolveActiveOptions,
} from '../database/repositories/skill-binding.repository';
