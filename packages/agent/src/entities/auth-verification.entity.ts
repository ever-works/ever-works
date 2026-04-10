import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'verification' })
@Index(['identifier'])
@Index(['value'], { unique: true })
export class AuthVerification {
    @PrimaryColumn({ type: 'varchar' })
    id: string;

    @Column({ type: 'varchar' })
    identifier: string;

    @Column({ type: 'varchar' })
    value: string;

    @Column()
    expiresAt: Date;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
