// Public surface of the agent-side Skills module
// (Agents/Skills/Tasks PR #1017 — Phase 8 + 9).
export * from './skills.module';
export * from './skills.service';
export { Skill, type SkillOwnerType, type SkillFrontmatter } from '../entities/skill.entity';
export {
	SkillBinding,
	type SkillBindingTargetType,
} from '../entities/skill-binding.entity';
export {
	SkillRepository,
	type ListSkillsFilter,
} from '../database/repositories/skill.repository';
export {
	SkillBindingRepository,
	type ResolvedSkill,
	type ResolveActiveOptions,
} from '../database/repositories/skill-binding.repository';
