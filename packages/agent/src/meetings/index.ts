// Public surface of Meetings v1 (Wave 8, feature a): owner-scoped
// meetings with transcript capture, best-effort AI summaries + Memory
// observations, the `zoom.recording` envelope→Meeting processor, and
// the `list_meetings` / `get_meeting_summary` chat tool factory.
export * from './meetings.module';
export * from './meetings.service';
export * from './meeting.repository';
export * from './agent-meeting-tools';
export { Meeting } from '../entities/meeting.entity';
export type { MeetingParticipant, MeetingSource } from '../entities/meeting.entity';
