import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    OneToMany,
    JoinColumn,
    Index,
} from 'typeorm';
import { User } from './user.entity';
import { ConversationMessage } from './conversation-message.entity';
import { ClassToObject } from './types';

@Entity({ name: 'conversations' })
@Index(['userId', 'updatedAt'])
export class Conversation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    @Index()
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user: User;

    @Column({ type: 'varchar', length: 200, nullable: true })
    title?: string;

    @Column({ type: 'varchar', length: 100, nullable: true })
    providerId?: string;

    @Column({ type: 'varchar', length: 100, nullable: true })
    model?: string;

    @Column({ type: 'simple-json', nullable: true })
    metadata?: Record<string, unknown>;

    @OneToMany(() => ConversationMessage, (msg) => msg.conversation, { cascade: true })
    messages: ClassToObject<ConversationMessage>[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
