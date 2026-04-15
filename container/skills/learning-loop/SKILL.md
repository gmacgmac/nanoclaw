---
name: learning-loop
description: Defines the format and quality criteria for extracted skills written during memory flush. Loaded when learningLoop is enabled in containerConfig.
---

# Skill Extraction — Format & Quality Guide

During memory flush, you may be asked to extract reusable skills from the session. This skill defines what to write and how.

## Extracted Skill File Format

Write each skill as a Markdown file in `extracted-skills/[skill-name].md` with this structure:

```markdown
---
name: [skill-name]
extracted: YYYY-MM-DD
source_group: [group-folder]
confidence: high|medium|low
---

# [Skill Name]

## When to Use
[Conditions under which this skill applies]

## Pattern
[The reusable pattern — steps, commands, decision logic]

## Example
[Concrete example from the session that demonstrates the pattern]

## Notes
[Caveats, limitations, or edge cases]
```

## What Makes a Good Skill

Extract patterns that are:
- **Reusable** — applies beyond this single session
- **Non-obvious** — not something any developer would already know
- **Concrete** — includes specific commands, file paths, or decision criteria
- **Tested** — the pattern was actually used successfully in the session

Good examples:
- A multi-step workflow for deploying a specific service
- A debugging sequence that resolved a tricky issue
- A decision framework for choosing between approaches
- A tool usage pattern that was particularly effective

## What to Skip

Do NOT extract:
- Generic programming knowledge (how to write a for loop)
- One-off fixes that won't recur
- Trivial exchanges (greetings, status checks)
- Patterns already captured in existing skills

## Confidence Levels

- **high** — Pattern was used multiple times successfully, or is a well-established workflow
- **medium** — Pattern worked once and seems generalizable
- **low** — Pattern is promising but untested beyond this session

## Limits

- Cap at **2 skills per flush** — quality over quantity
- Skip extraction entirely if the session had no meaningful work
