import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    OneToMany,
    Index,
} from 'typeorm';
import { User } from './user.entity';
import { ChatMessage } from './chat-message.entity';
import { ClassToObject } from './types';

@Entity({ name: 'chat_histories' })
@Index(['sessionId', 'userId'])
export class ChatHistory {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    sessionId: string;

    @Column({ nullable: true })
    userId: string;

    @Column({ nullable: true })
    title: string;

    @Column({ type: 'json', nullable: true })
    metadata: Record<string, any>;

    @Column({ default: true })
    isActive: boolean;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    // Relationships
    @ManyToOne(() => User, { nullable: true, onDelete: 'CASCADE' })
    user: ClassToObject<User>;

    @OneToMany(() => ChatMessage, (message) => message.chatHistory, {
        cascade: true,
        eager: false,
    })
    messages: ClassToObject<ChatMessage>[];
}
