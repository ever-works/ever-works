import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    ManyToOne,
    Index,
} from 'typeorm';
import { ChatHistory } from './chat-history.entity';
import type { ClassToObject } from './types';

export type MessageRole = 'user' | 'assistant' | 'system' | 'function' | 'tool';

@Entity({ name: 'chat_messages' })
@Index(['chatHistoryId', 'createdAt'])
export class ChatMessage {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    chatHistoryId: string;

    @Column()
    role: string;

    @Column({ type: 'text' })
    content: string;

    @Column({ nullable: true })
    name?: string;

    @Column({ type: 'json', nullable: true })
    additionalKwargs?: Record<string, any>;

    @Column({ type: 'json', nullable: true })
    functionCall?: {
        name: string;
        arguments: string;
    };

    @Column({ type: 'json', nullable: true })
    toolCalls?: Array<{
        id: string;
        type: string;
        function: {
            name: string;
            arguments: string;
        };
    }>;

    @Column({ type: 'json', nullable: true })
    metadata?: Record<string, any>;

    @Column({ default: 0 })
    orderIndex: number;

    @CreateDateColumn()
    createdAt: Date;

    // Relationships
    @ManyToOne(() => ChatHistory, (history) => history.messages, {
        onDelete: 'CASCADE',
    })
    chatHistory: ClassToObject<ChatHistory>;
}
