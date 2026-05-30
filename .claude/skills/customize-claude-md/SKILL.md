---
name: customize-claude-md
description: Build or upgrade a group's CLAUDE.md using the modular prompt-behaviours snippet library. Creates new CLAUDE.md files from scratch or audits/upgrades existing ones. Triggers on "customize group", "build claude.md", "upgrade claude.md", or direct invocation.
---

# Customize Group CLAUDE.md

Build or upgrade a group's `CLAUDE.md` by assembling modular behaviour snippets from the prompt-behaviours library. Handles both new groups (from scratch) and existing groups (audit + patch).

## Snippet Library Location

```
docs/prompt-behaviours/
```

Each file is a self-contained markdown section starting with frontmatter, then a `##` heading, ending with two newlines. Snippets are written to be concatenated directly into a CLAUDE.md — no transformation needed. Tool names already carry the `mcp__nanoclaw__` prefix, and `core_memory-protocol.md` already includes the `@memory/MEMORY.md` import line.

**If the folder doesn't exist or is empty**, use the Quick Start fallback (see bottom) — copy a template CLAUDE.md instead.

## How Inclusion Works (Frontmatter-Driven)

Every snippet declares its own inclusion rules in frontmatter. Do NOT rely on a hardcoded list — read the frontmatter of each file and decide from that. This keeps the skill correct even as snippets are added or changed.

```
---
category: core | comms | scheduling | builder | admin
default: true | false
condition: <short phrase>   # present only when default is false
---
```

Selection rule:
- `default: true` → include in every group.
- `default: false` → include only if the group's profile matches `condition`.

### The Group Profile

Derive these facts about the group, then match them against each conditional snippet's `condition`:

| Profile fact | How to determine it |
|--------------|---------------------|
| Channel | Folder prefix: `telegram_` / `slack_` / `whatsapp_` / `discord_`. Pick the one matching formatting snippet. |
| Main group | `isMain` in the group's config (ask, or check `configure-group` / registered_groups). Gates `comms_cross-group`. |
| Cross-group routing | Group sits behind a multi-agent router hub. Gates `comms_routed-messages`. |
| Attachments | Channel supports file attachments (Telegram/Slack/WhatsApp/Discord all do). Gates `comms_send-attachments`. |
| Writes/deploys code | Group does code/deploy work. Gates all `builder_` snippets. |
| Dedicated admin group | A purpose-built admin group (does not exist yet). Gates `admin_*` snippets. |

> **What's NOT default** (must opt in via profile):
> - All `builder_*` — only code/deploy groups
> - `comms_send-attachments` — only attachment-capable channels
> - `comms_routed-messages` — only groups behind a router hub
> - `comms_cross-group` — main groups only (cross-group send + `delegate_to_group` are main-gated in the platform)
> - All `comms_*-formatting` — pick the single one matching the channel
> - All `admin_*` — **dedicated admin group ONLY.** Do NOT assign to any main or standard group. Group registration/add/remove (`register_group`) is privileged and reserved for a future admin group; its safety is under review. Main groups get read-only group *discovery* (to pick delegation targets) inline, NOT the admin snippet.
>
> Everything else (`core_*`, `comms_response-delivery`, `comms_delegated-tasks`, all `scheduling_*`) is default. Note `comms_delegated-tasks` IS default — any group can be a delegation target via `respond_to_group`, even though only main can *initiate* delegation. Note `core_dependency-security` is default (not builder) — any group with shell access can run package installs, so supply-chain hygiene is universal.

### Capability Facts (verified against platform code)

- Plain `send_message` (own group) — every group.
- `send_message` with `target_jid` (cross-group) — main only.
- `delegate_to_group` — main only.
- `respond_to_group` — any group (authorized by being the delegation target).

## Mode: New Group

When the group has no CLAUDE.md yet.

### Step 1: Gather Context

AskUserQuestion: "Tell me about this group:"
- Purpose? (general assistant, scheduler, finance, code builder, etc.)
- Channel? (Telegram, Slack, Discord, WhatsApp)
- Main group or not?
- Does it write or deploy code?
- Does it sit behind a multi-agent router hub?

These answers populate the Group Profile above.

### Step 2: Build the Persona

The persona goes at the top and is always custom — never from a snippet. Archetypes to offer:

**General Assistant:**
```markdown
# [Name]

You are [Name], a personal assistant. You're direct, no-nonsense, and get things done without fuss. No filler phrases, no over-explaining, no performing helpfulness — just help.

Short sentences. Casual tone. Match the energy of the conversation.
```

**Domain Specialist:**
```markdown
# [Name]

You are [Name], a [domain] specialist. You're sharp, direct, and know your field deeply. You call things as you see them — no padding, no hedging.

Think less "AI assistant" and more "[relatable expert analogy]."
```

**Household/Schedule Manager:**
```markdown
# [Name]

You are [Name], a sharp, no-nonsense [role]. Your core job is [primary mission]. [What success looks like].

You *know* the [domain]. When someone mentions [X], you know [Y]. This isn't optional — it's your job.
```

AskUserQuestion: "Which style fits, or something different?" Then refine name, one-sentence mission, what "performing better than the human" means here, and tone.

### Step 3: Select Snippets

Read the frontmatter of every file in `docs/prompt-behaviours/`. Include all `default: true`. For each `default: false`, include only if its `condition` matches the Group Profile from Step 1.

### Step 4: Assemble

Order:
1. **Persona** (custom, Step 2)
2. **Core tenets** (custom — 3-6 non-negotiable principles for this group)
3. **How You Talk** (tone rules — usually standard)
4. **Core behaviours** (all `core_` snippets)
5. **Communication** (selected `comms_` snippets, formatting last)
6. **Scheduling** (`scheduling_` snippets)
7. **Builder** (selected `builder_` snippets)
8. **Domain-specific** (custom sections unique to this group)

Read each selected snippet and concatenate in order. Strip the frontmatter block from each snippet during assembly — it's metadata for selection, not content for the CLAUDE.md. The two trailing newlines handle spacing. No other transformation: tool prefixes and the memory import are already baked in.

### Step 5: Review and Write

Show the assembled CLAUDE.md in full. AskUserQuestion: "Does this look right? Anything to add, remove, or tweak?" Iterate, then write to `groups/<folder>/CLAUDE.md`.

---

## Mode: Existing Group (Audit & Upgrade)

### Step 1: Read Current State

Read the existing `groups/<folder>/CLAUDE.md` in full.

### Step 2: Build the Profile + Inventory Snippets

Derive the Group Profile (channel, main, routing, attachments, code). Read all snippet frontmatter. The expected set = all defaults + conditionals whose `condition` matches the profile. For each expected snippet, check whether the CLAUDE.md already covers that behaviour (even if worded differently).

### Step 3: Gap Report

Present a table covering only snippets relevant to this group's profile:

```
Snippet                          Status
─────────────────────────────────────────
core_question-gate               ✗ Missing
core_read-before-edit            ✗ Missing
core_output-integrity            ~ Partial (has internal tags, no visible-output rule)
comms_response-delivery          ✓ Present
scheduling_day-verification      ✓ Present
...
```

- `✓` present and current
- `~` present but outdated/incomplete (say what's missing)
- `✗` missing
- Also flag any snippet present in the file that's NOT in the expected set (candidate for removal — e.g. wrong channel's formatting).

### Step 4: Propose Changes

For each gap: where to add it. For each outdated section: propose replacing with the canonical snippet. For ordering: note moves.

**Never replace or modify without explicit permission.** Present as proposals and wait for "go ahead" / "do it" / "apply".

AskUserQuestion: "Which changes should I apply? (all / specific ones / none)"

### Step 5: Apply

- Adding: read the snippet (minus frontmatter), insert at the correct position.
- Replacing outdated: show old vs new, then replace.
- Reordering: move, preserve content.

Preserve all custom content (persona, core tenets, domain sections) that isn't in the library. After applying, show the final header structure so the user can confirm order.

---

## Quick Start (No Snippets Available)

If `docs/prompt-behaviours/` is absent (e.g. a different repo without the library), fall back to copying a template as the base:

- **Main groups**: copy `groups/main/CLAUDE.md`
- **Non-main groups**: copy `groups/global/CLAUDE.md`

Then customise the persona and add domain-specific content. Mention that the snippet library enables more granular control and offer to set it up.

---

## Rules

1. **Never overwrite without permission.** Show changes, wait for explicit approval.
2. **Preserve custom content.** Persona, core tenets, and domain sections not in the library survive upgrades untouched.
3. **Order matters.** Identity first, universal rules next, then progressively more specific content.
4. **Frontmatter is the source of truth for inclusion.** Don't hardcode which snippets apply — read `default` and `condition`.
5. **Snippets are canonical.** If a group hand-wrote something that now exists as a snippet, propose replacing it with the snippet (don't force it).
6. **Strip frontmatter on assembly.** It's selection metadata, not CLAUDE.md content.
7. **One formatting snippet per group.** Match the channel; drop the rest.
