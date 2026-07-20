// Teams & Prebuilt Companies — public surface of the agent-side teams
// module (docs/specs/features/teams-and-companies/spec.md §3). Re-exports
// the entities so callers don't need deep imports from `../entities/*`.
export * from './teams.service';
export * from './org-chart.service';
export * from './team-resources.service';
export * from './teams.module';
export * from './types';
export { Team } from '../entities/team.entity';
export type { TeamMetadata } from '../entities/team.entity';
export { TeamMember } from '../entities/team-member.entity';
export type { TeamMemberRole, TeamMemberType } from '../entities/team-member.entity';
export { TeamResource, TEAM_RESOURCE_TYPES } from '../entities/team-resource.entity';
export type { TeamResourceType } from '../entities/team-resource.entity';
