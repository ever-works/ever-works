import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'session' })
@Index(['token'], { unique: true })
@Index(['userId'])
export class AuthSession {
    @PrimaryColumn({ type: 'varchar' })
    id: string;

    @Column({ type: 'varchar' })
    userId: string;

    @Column({ type: 'varchar' })
    token: string;

    @Column()
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
