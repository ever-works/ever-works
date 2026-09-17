// Public surface of the named-Conversations domain module
// (`@ever-works/agent/conversations`).
export * from './conversations.module';
export * from './conversation.types';
export * from './conversation-dispatcher';
export * from './conversation-context.resolver';
export * from './conversation-attachment.resolver';
export * from './conversation.service';
export * from './conversation-mention.service';
export * from './conversation-dispatch.service';
export * from './conversation-message.service';
export { ConversationParticipant } from '../entities/conversation-participant.entity';
export { ConversationParticipantRepository } from '../database/repositories/conversation-participant.repository';
