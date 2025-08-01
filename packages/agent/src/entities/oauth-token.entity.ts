import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    CreateDateColumn,
    UpdateDateColumn,
    Index,
} from 'typeorm';
import { User } from './user.entity';

@Entity()
@Index(['userId', 'provider'], { unique: true })
export class OAuthToken {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    user: User;

    @Column()
    provider: string; // 'github', 'google', etc.

    @Column({ type: 'text' })
    accessToken: string;

    @Column({ type: 'text', nullable: true })
    refreshToken: string;

    @Column({ nullable: true })
    tokenType: string; // Usually 'Bearer'

    @Column({ nullable: true })
    scope: string; // Comma-separated scopes

    @Column({ nullable: true })
    expiresAt: Date;

    @Column({ type: 'json', nullable: true })
    metadata: Record<string, any>; // Additional provider-specific data

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}