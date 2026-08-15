import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { Skill } from './skill.entity';
import { User } from './user.entity';

/**
 * Skills feature — companion files (spec `features/skills/tasks.md` T14
 * successor; sidecar taxonomy per `features/agent-plugins/spec.md` US-6).
 *
 * A `SkillFile` row indexes ONE companion file of a Skill — a script,
 * a reference doc, a config, or an asset. The bytes live in the
 * uploads spine (`user_uploads` + the active Storage plugin), keyed by
 * `uploadId` (the sha256 the uploads API returns); this row carries the
 * skill-facing metadata (display filename, kind, size, mime) and the
 * ownership scope.
 *
 * Kind taxonomy (US-6): `script` entries are CODE and are DATA-ONLY in
 * v1 — readable via `getSkillFile`, never executed. `reference`,
 * `asset`, and `config` are plain data.
 */
export type SkillFileKind = 'script' | 'reference' | 'asset' | 'config';

export const SKILL_FILE_KINDS: readonly SkillFileKind[] = [
    'script',
    'reference',
    'asset',
    'config',
];

@Entity({ name: 'skill_files' })
@Index('uq_skill_files_skill_filename', ['skillId', 'filename'], { unique: true })
@Index('idx_skill_files_skill', ['skillId'])
@Index('idx_skill_files_user', ['userId'])
export class SkillFile {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    skillId: string;

    @ManyToOne(() => Skill, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'skillId' })
    skill?: Skill;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    /** sha256 content hash — the upload id in `user_uploads` / the uploads API. */
    @Column({ type: 'varchar', length: 64 })
    uploadId: string;

    /** Display filename inside the skill (`analyze.py`). Unique per skill. */
    @Column({ type: 'varchar', length: 255 })
    filename: string;

    @Column({ type: 'varchar', length: 16 })
    kind: SkillFileKind;

    @Column({ type: 'int' })
    sizeBytes: number;

    @Column({ type: 'varchar', length: 128 })
    mime: string;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
