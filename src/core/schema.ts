// Data model: zod schemas are the single source; schema/*.json is generated from them (C8).
import { z } from 'zod';

export const STORE_SCHEMA = 'laneboard/store@1';
export const STORE_VERSION = 1;
// config@1 is what every board without the optional keys of config@2 keeps (0.3.1 reads it); config@2 is written only when the owner
// turns one of them on (review, create_by), so a board without them stays readable by 0.3.1 (ADR §24, owner TG 8723).
export const CONFIG_SCHEMA = 'laneboard/config@1';
export const CONFIG_VERSION = 1;
export const CONFIG_SCHEMA_V2 = 'laneboard/config@2';
export const CONFIG_VERSION_MAX = 2;

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

export const ACTOR_SOURCES = ['explicit', 'default'] as const;
// One line of visible text (board name, board description).
const ONE_LINE_RE = /^(?=.*\S)[^\u0000-\u001F\u007F]+$/;
export const BoardName = z.string().min(1).max(60).regex(ONE_LINE_RE, 'name must be one line of visible text');
export const BoardDescription = z.string().min(1).max(200).regex(ONE_LINE_RE, 'description must be one line of visible text');

export const TaskEvent = z.looseObject({
  at: Timestamp,
  actor: Actor,
  // How the actor got its name: explicit (--as, MCP actor, LANEBOARD_AGENT) or the session's default name.
  actor_source: z.enum(ACTOR_SOURCES).optional(),
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
    // Id of the parent task on the same board (a subtask, ADR §25); absent for a top-level task, never null.
    parent: z.string().regex(ID_RE).optional(),
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
    // Board name and one-line description (whose project, what work); optional for stores made before they existed.
    name: BoardName.optional(),
    description: BoardDescription.optional(),
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

// Checks of a board (P1, S6j): the statuses a handed-in task passes through in order, and who may pass or accept it (empty or
// absent: anybody but the assignee). The assignee's finish hands in to the first one; a checker's finish passes the task on to the
// next one, from the last one to the final status (accepted).
export const ReviewConfig = z.strictObject({
  statuses: z.array(z.string().regex(STATUS_RE)).min(1),
  by: z.array(Actor).optional(),
});

// The config@2 keys, each optional (owner TG 8723): review (P1) and create_by (who creates tasks, P2; checked from S6m on).
export const CONFIG_V2_KEYS = ['review', 'create_by'] as const;

// config@2: config@1 plus the optional keys; its JSON Schema is schema/config.json (a config@1 file is the same without them).
export const ConfigV2 = Config.extend({
  review: ReviewConfig.optional(),
  create_by: z.array(Actor).min(1).optional(),
}).meta({ title: 'laneboard config (.laneboard/config.json)' });

export type LinkT = z.infer<typeof Link>;
export type AttachmentT = z.infer<typeof Attachment>;
export type TaskEventT = z.infer<typeof TaskEvent>;
export type TaskT = z.infer<typeof Task>;
export type StoreFileT = z.infer<typeof StoreFile>;
export type FieldDefT = z.infer<typeof FieldDef>;
export type ConfigT = z.infer<typeof ConfigV2>;
export type ReviewConfigT = z.infer<typeof ReviewConfig>;

// JSON Schema of config.json as laneboard reads it (LB-62.7): config@2 keeps keys of a newer laneboard at the top level and inside
// review (validateConfig), so those two objects allow more properties; a config@1 file holds only the 0.3.1 keys (`if`/`then`).
function configJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ConfigV2, { target: 'draft-2020-12' }) as Record<string, unknown> & { properties: Record<string, Record<string, unknown>> };
  const review = schema.properties.review;
  if (review !== undefined) review.additionalProperties = {};
  const title = schema.title;
  delete schema.title;
  return {
    ...schema,
    additionalProperties: {},
    if: { properties: { schema: { const: CONFIG_SCHEMA } }, required: ['schema'] },
    then: { propertyNames: { enum: Object.keys(Config.shape) } },
    title,
  };
}

// JSON Schema documents generated from the zod schemas, keyed by output file name.
export function jsonSchemas(): Record<string, unknown> {
  return {
    'task.json': z.toJSONSchema(Task, { target: 'draft-2020-12' }),
    'store.json': z.toJSONSchema(StoreFile, { target: 'draft-2020-12' }),
    'config.json': configJsonSchema(),
  };
}
