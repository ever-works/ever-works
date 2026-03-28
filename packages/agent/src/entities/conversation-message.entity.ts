import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    ManyToOne,
    JoinColumn,
    Index,
} from 'typeorm';
import { Conversation } from './conversation.entity';
import { ClassToObject } from './types';

export type ConversationMessageRole = 'user' | 'assistant' | 'system' | 'tool';

@Entity({ name: 'conversation_messages' })
@Index(['conversationId', 'createdAt'])
export class ConversationMessage {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    @Index()
    conversationId: string;

    @ManyToOne(() => Conversation, (conv) => conv.messages, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'conversationId' })
    conversation: ClassToObject<Conversation>;

    @Column({ type: 'varchar', length: 20 })
    role: ConversationMessageRole;

    @Column({ type: 'text' })
    content: string;

    /** Full UIMessage parts array — preserves tool calls, results, and all part types */
    @Column({ type: 'simple-json', nullable: true })
    parts?: unknown[];

    @Column({ type: 'varchar', length: 100, nullable: true })
    model?: string;

    @Column({ type: 'simple-json', nullable: true })
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };

    @CreateDateColumn()
    createdAt: Date;
}
