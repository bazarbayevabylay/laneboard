// Data model: zod schemas are the single source; schema/*.json is generated from them (C8).
import { z } from 'zod';

export const STORE_SCHEMA = 'laneboard/store@1';
export const STORE_VERSION = 1;
export const CONFIG_SCHEMA = 'laneboard/config@1';
export const CONFIG_VERSION = 1;

export const ID_RE = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$/;
export const PREFIX_RE = /^[A-Z][A-Z0-9]{0,9}$/;
export const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;
export const LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const STATUS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const ATTACHMENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const SHA256_RE = /^[a-f0-9]{64}$/;

export const LINK_KINDS = ['task', 'branch', 'pr', 'commit', 'url', 'file'] as const;
export const EVENT_TYPES = ['created', 'updated', 'status', 'assigned', 'commented', 'attached', 'detached', 'archived', 'restored'] as const;
export const FIELD_TYPES = ['string', 'number', 'boolean', 'string[]', 'json'] as const;
export const SCOPES = ['active', 'archive', 'all'] as const;
export const FILE_KINDS = ['active', 'archive'] as const;

export type LinkKind = (typeof LINK_KINDS)[number];
export type EventType = (typeof EVENT_TYPES)[number];
export type FieldType = (typeof FIELD_TYPES)[number];
export type Scope = (typeof SCOPES)[number];
export type FileKind = (typeof FILE_KINDS)[number];

export const Timestamp = z.iso.datetime();
export const Actor = z.string().regex(ACTOR_RE, 'actor must match ^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$');

export const Link = z.strictObject({
  kind: z.enum(LINK_KINDS),
  ref: z.string().min(1).max(2000),
});

export const Attachment = z.strictObject({
  name: z.string().regex(ATTACHMENT_NAME_RE),
  size: z.int().min(0),
  sha256: z.string().regex(SHA256_RE),
  mime: z.string(),
  added_by: Actor,
  added_at: Timestamp,
});

export const TaskEvent = z.looseObject({
  at: Timestamp,
  actor: Actor,
  type: z.enum(EVENT_TYPES),
  data: z.record(z.string(), z.unknown()),
});

export const Task = z
  .looseObject({
    id: z.string().regex(ID_RE),
    rev: z.int().min(1),
    title: z.string().min(1).max(200),
    description: z.string().max(100000),
    status: z.string().min(1),
    assignee: Actor.nullable(),
    labels: z.array(z.string().regex(LABEL_RE)),
    links: z.array(Link),
    fields: z.record(z.string(), z.unknown()),
    attachments: z.array(Attachment),
    events: z.array(TaskEvent),
    events_dropped: z.int().min(0),
    created_at: Timestamp,
    created_by: Actor,
    updated_at: Timestamp,
    updated_by: Actor,
    archived_at: Timestamp.optional(),
  })
  .meta({ title: 'laneboard task' });

export const StoreFile = z
  .looseObject({
    schema: z.string().regex(/^laneboard\/store@[1-9][0-9]*$/),
    kind: z.enum(FILE_KINDS),
    rev: z.int().min(0),
    next_id: z.int().min(1).optional(),
    updated_at: Timestamp,
    content_sha256: z.string().regex(SHA256_RE),
    tasks: z.array(Task),
  })
  .meta({ title: 'laneboard store file (active.json / archive.json)' });

export const FieldDef = z.strictObject({
  type: z.enum(FIELD_TYPES),
  description: z.string().max(500).optional(),
});

export const Config = z
  .strictObject({
    schema: z.string().regex(/^laneboard\/config@[1-9][0-9]*$/),
    prefix: z.string().regex(PREFIX_RE),
    statuses: z.array(z.string().regex(STATUS_RE)).min(1),
    fields: z.record(z.string().regex(FIELD_KEY_RE), FieldDef),
    limits: z.strictObject({
      events_per_task: z.int().min(1),
      attachment_bytes: z.int().min(1),
      list_limit_max: z.int().min(1),
    }),
    attachments: z.strictObject({
      deny_names: z.array(z.string().min(1)),
    }),
    board: z.strictObject({
      port: z.int().min(0).max(65535),
    }),
  })
  .meta({ title: 'laneboard config (.laneboard/config.json)' });

export type LinkT = z.infer<typeof Link>;
export type AttachmentT = z.infer<typeof Attachment>;
export type TaskEventT = z.infer<typeof TaskEvent>;
export type TaskT = z.infer<typeof Task>;
export type StoreFileT = z.infer<typeof StoreFile>;
export type FieldDefT = z.infer<typeof FieldDef>;
export type ConfigT = z.infer<typeof Config>;

// JSON Schema documents generated from the zod schemas, keyed by output file name.
export function jsonSchemas(): Record<string, unknown> {
  return {
    'task.json': z.toJSONSchema(Task, { target: 'draft-2020-12' }),
    'store.json': z.toJSONSchema(StoreFile, { target: 'draft-2020-12' }),
    'config.json': z.toJSONSchema(Config, { target: 'draft-2020-12' }),
  };
}
