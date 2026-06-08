import { z } from 'zod';
import { JidSchema, FolderSchema, ContainerChannelSchema } from './common.js';
import { ContainerConfigSchema } from './container-config.js';

// --- Full group (as returned by GET endpoints) ---

export const RegisteredGroupSchema = z.object({
  name: z
    .string()
    .describe(
      'Human-readable group name (e.g. "Research Team", "Personal Assistant").',
    ),
  folder: FolderSchema,
  trigger: z
    .string()
    .describe(
      'Trigger phrase that activates the agent in this group (e.g. "@Andy", "@bot"). Messages must start with this to be processed.',
    ),
  added_at: z.iso
    .datetime()
    .describe('ISO 8601 timestamp of when this group was registered.'),
  containerConfig: ContainerConfigSchema.optional().describe(
    'Container and agent configuration. Omit to use all defaults.',
  ),
  requiresTrigger: z
    .boolean()
    .optional()
    .describe(
      'Whether messages need the trigger phrase to be processed. Default: true for groups, false for solo/internal chats.',
    ),
  multiAgentRouter: z
    .boolean()
    .optional()
    .describe(
      "When true (main groups only): scan incoming messages for other groups' triggers and auto-delegate to them.",
    ),
  isMain: z
    .boolean()
    .optional()
    .describe(
      'True for the main control group. Has elevated privileges, no trigger required, can register/unregister other groups.',
    ),
  isAdmin: z
    .boolean()
    .optional()
    .describe(
      'True for the admin group. Superset of main — owns register_group IPC command.',
    ),
  containerChannel: ContainerChannelSchema.optional().describe(
    'Which container image channel this group uses. Default: "stable".',
  ),
});

// --- Create group request ---

export const CreateGroupSchema = z.object({
  jid: JidSchema.describe(
    'Unique identifier for the group. For dashboard groups use "<name>@internal". For Telegram use "tg:<chat_id>[:<bot_name>]".',
  ),
  name: z.string().min(1).max(100).describe('Human-readable group name.'),
  folder: FolderSchema.describe(
    'Folder name for this group. Will be created under groups/. Must be unique.',
  ),
  trigger: z
    .string()
    .min(1)
    .optional()
    .describe('Trigger phrase. Defaults to "@{ASSISTANT_NAME}" if omitted.'),
  containerConfig: ContainerConfigSchema.optional().describe(
    'Initial container configuration. Can be set/updated later via PATCH.',
  ),
  requiresTrigger: z
    .boolean()
    .optional()
    .describe('Whether trigger is required. Default: true.'),
  isMain: z
    .boolean()
    .optional()
    .describe('Mark as main group. Default: false.'),
  isAdmin: z
    .boolean()
    .optional()
    .describe('Mark as admin group. Default: false.'),
  containerChannel: ContainerChannelSchema.optional().describe(
    'Image channel. Default: "stable".',
  ),
});

// --- Update group (top-level fields only, not config) ---

export const UpdateGroupSchema = z
  .object({
    name: z.string().min(1).max(100).optional().describe('New group name.'),
    trigger: z.string().min(1).optional().describe('New trigger phrase.'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe('Update trigger requirement.'),
    multiAgentRouter: z
      .boolean()
      .optional()
      .describe('Enable/disable multi-agent routing.'),
    containerChannel: ContainerChannelSchema.optional().describe(
      'Switch image channel.',
    ),
  })
  .describe(
    'Partial update to group top-level fields. Only provided fields are changed.',
  );

// --- Patch config (merge semantics) ---

export const PatchConfigSchema = ContainerConfigSchema.describe(
  'Merge-patch for containerConfig. Shallow merge at the top level: only provided fields are updated, omitted fields are untouched, null removes a field. ' +
    'IMPORTANT: mcpServers and additionalMounts are replaced wholesale when included (not deep-merged). ' +
    'To add/remove an entry without clobbering others, read the current config first (GET /config), merge locally, then PATCH with the complete object/array.',
);

// --- Switch preset request ---

export const SwitchPresetSchema = z.object({
  preset: z
    .string()
    .min(1)
    .describe('Preset name to switch to. Must exist in model-presets.json.'),
});

// --- Response wrappers ---

export const GroupResponseSchema = z.object({
  data: RegisteredGroupSchema.extend({ jid: JidSchema }),
});

export const GroupListResponseSchema = z.object({
  data: z.array(RegisteredGroupSchema.extend({ jid: JidSchema })),
});
