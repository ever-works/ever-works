import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { TimestampColumn } from './_types';

@Entity({ name: 'sessions' })
@Index(['token'], { unique: true })
@Index(['userId'])
export class AuthSession {
    @PrimaryColumn({ type: 'varchar' })
    id: string;

    @Column({ type: 'varchar' })
    userId: string;

    @Column({ type: 'text' })
    token: string;

    @TimestampColumn()
    expiresAt: Date;

    @Column({ type: 'varchar', nullable: true })
    ipAddress?: string | null;

    @Column({ type: 'varchar', nullable: true })
    userAgent?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
