---
name: customize-claude-md
description: Build or upgrade a group's CLAUDE.md using the modular prompt-behaviours snippet library. Creates new CLAUDE.md files from scratch or audits/upgrades existing ones. Triggers on "customize group", "build claude.md", "upgrade claude.md", or direct invocation.
---

# Customize Group CLAUDE.md

Build or upgrade a group's `CLAUDE.md` by assembling modular behaviour snippets from the prompt-behaviours library. This skill handles both new groups (from scratch) and existing groups (audit + patch).

## Snippet Library Location

Behaviour snippets live at:

```
docs/prompt-behaviours/
```

Each file is a self-contained markdown section (starts with `##`), ends with two newlines, and is designed to be concatenated directly into a CLAUDE.md.

**If the folder doesn't exist or is empty**, tell the user:

> The prompt-behaviours library isn't set up yet. This folder should contain modular `.md` snippets that define agent behaviours. Would you like me to help you create the initial set?

Then guide them through creating the core snippets based on the categories below.

## Snippet Categories

Files are named `{category}_{descriptor}.md`:

| Prefix | Purpose | When to include |
|--------|---------|-----------------|
| `core_` | Universal behaviours — every group gets these | Always |
| `comms_` | Channel communication mechanics | Groups that talk to users |
| `scheduling_` | Date/time awareness, task management | Groups that handle reminders or scheduled work |
| `builder_` | Code, git, deployment patterns | Groups that write/deploy code |

## Mode: New Group

When building a CLAUDE.md for a new group (file doesn't exist yet):

### Step 1: Gather Context

AskUserQuestion: "Tell me about this group:"
- What's its purpose? (general assistant, scheduler, finance, code builder, etc.)
- What channel is it on? (Telegram, Slack, Discord, WhatsApp)
- Is it a main group or a non-main group?
- Does it handle scheduling/reminders?
- Does it write or deploy code?
- Does it participate in cross-group routing or delegation?

### Step 2: Build the Persona

The persona section goes at the top of the CLAUDE.md. It's always custom — never from a snippet.

Guide the user through creating it. Offer these archetypes as starting points:

**General Assistant:**
```markdown
# [Name]

You are [Name], a personal assistant. You're direct, no-nonsense, and get things done without fuss. No filler phrases, no over-explaining, no performing helpfulness — just help.

Short sentences. Casual tone. Match the energy of the conversation.
```

**Domain Specialist:**
```markdown
# [Name]

You are [Name], a [domain] specialist. You're sharp, direct, and know your field deeply. You call things as you see them — no padding, no hedging, no performing expertise you don't have.

Think less "AI assistant" and more "[relatable expert analogy]."
```

**Household/Schedule Manager:**
```markdown
# [Name]

You are [Name], a sharp, no-nonsense [role]. Your core job is [primary mission]. [What success looks like].

You *know* the [domain]. When someone mentions [X], you know [Y]. This isn't optional — it's your job.
```

AskUserQuestion: "Which style fits, or would you like something different?"

After choosing, help them refine:
- Name
- Core mission (one sentence)
- What "performing better than the human" looks like for this group
- Tone calibration (dry/witty, warm, purely functional)

### Step 3: Select Snippets

Based on the context gathered in Step 1, select applicable snippets:

**Always include (core_):**
- `core_ack-before-working.md`
- `core_question-gate.md`
- `core_read-before-edit.md`
- `core_how-not-cant.md`
- `core_memory-protocol.md`
- `core_multiple-messages.md`
- `core_internal-tags.md`

**If the group talks to users (comms_):**
- `comms_response-delivery.md`
- `comms_visible-output-rule.md`
- `comms_send-attachments.md`
- Channel-specific formatting (e.g. `comms_telegram-formatting.md`)
- `comms_routed-messages.md` (if cross-group routing is needed)
- `comms_delegated-tasks.md` (if delegation is needed)

**If the group handles scheduling (scheduling_):**
- `scheduling_date-awareness.md`
- `scheduling_day-verification.md` (if schedule-heavy)
- `scheduling_task-validation.md`
- `scheduling_task-constraints.md`
- `scheduling_now-token.md`

**If the group writes code (builder_):**
- `builder_git-discipline.md`
- `builder_dependency-security.md`
- `builder_async-operations.md` (if it does deployments/provisioning)
- `builder_procedure-context.md` (if it does structured feature work)

### Step 4: Assemble

Build the CLAUDE.md in this order:

1. **Persona** (custom, from Step 2)
2. **Core tenets** (custom per group — 3-6 non-negotiable principles)
3. **How You Talk** (tone rules — usually standard across groups)
4. **Core behaviours** (all `core_` snippets)
5. **Communication** (applicable `comms_` snippets)
6. **Scheduling** (applicable `scheduling_` snippets)
7. **Builder** (applicable `builder_` snippets)
8. **Domain-specific** (any custom sections unique to this group)

Read each selected snippet file and concatenate them in order. The two trailing newlines in each file handle spacing.

### Step 5: Review and Write

Show the assembled CLAUDE.md to the user in full.

AskUserQuestion: "Does this look right? Any sections to add, remove, or tweak?"

Iterate until they're happy, then write to `groups/<folder>/CLAUDE.md`.

---

## Mode: Existing Group (Audit & Upgrade)

When the group already has a CLAUDE.md:

### Step 1: Read Current State

Read the existing `groups/<folder>/CLAUDE.md` in full.

### Step 2: Inventory Snippets

Read all files in `docs/prompt-behaviours/`. For each snippet, check whether the existing CLAUDE.md already covers that behaviour (even if worded differently).

### Step 3: Gap Report

Present a table:

```
Snippet                          Status
─────────────────────────────────────────
core_ack-before-working          ✓ Present (but outdated — missing web search tools)
core_question-gate               ✗ Missing
core_read-before-edit            ✗ Missing
core_how-not-cant                ✗ Missing
core_memory-protocol             ✓ Present
core_multiple-messages           ✓ Present
core_internal-tags               ~ Partial (no visible-output rule)
comms_response-delivery          ✓ Present
comms_telegram-formatting        ✓ Present
scheduling_date-awareness        ✗ Missing
scheduling_task-validation       ✓ Present
...
```

Use:
- `✓` — present and up to date
- `~` — present but outdated or incomplete (explain what's missing)
- `✗` — missing entirely

### Step 4: Propose Changes

For each gap or outdated section, propose the fix:

- **Missing snippets**: "Add this section after [X]"
- **Outdated sections**: "Replace the current [section] with the canonical version"
- **Ordering issues**: "Move [section] to after [other section] for consistency"

**CRITICAL: Never replace or modify content without explicit permission.** Present all changes as proposals. Wait for "go ahead", "do it", "apply", etc.

AskUserQuestion: "Which of these changes should I apply?"

Options:
- All of them
- Specific ones (let them pick)
- None (just wanted the audit)

### Step 5: Apply

For each approved change:
- If adding a new section: read the snippet file, insert at the correct position
- If replacing an outdated section: show the diff (old vs new), then replace
- If reordering: move the section, preserve its content

After all changes, show the final CLAUDE.md structure (just headers, not full content) so the user can confirm the order is right.

---

## Quick Start (No Snippets Available)

If `docs/prompt-behaviours/` doesn't exist or is empty, fall back to copying from the template files:

- **Main groups**: Start from `groups/main/CLAUDE.md`
- **Non-main groups**: Start from `groups/global/CLAUDE.md`

Then customise the persona section and add any domain-specific content. Tell the user that the snippet library enables more granular control and offer to help set it up.

---

## Rules

1. **Never overwrite without permission.** Always show what you're about to change and wait for explicit approval.
2. **Preserve custom content.** Domain-specific sections, persona, and custom rules that aren't in the snippet library must be preserved during upgrades.
3. **Order matters.** The assembly order (persona → core → comms → scheduling → builder → domain) is intentional. It puts identity first, universal rules next, then progressively more specific content.
4. **Snippets are canonical.** If a group has a hand-written version of something that exists as a snippet, the snippet is the authoritative version. Propose replacing the hand-written version with the snippet (but don't force it).
5. **Two newlines between sections.** Every snippet ends with two newlines. When assembling, this creates clean visual separation without extra work.
