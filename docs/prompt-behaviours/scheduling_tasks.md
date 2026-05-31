---
category: scheduling
default: true
---
## Scheduled Task Mechanics

**Validate before editing.** Always read the full task with `get_task` before updating one — `list_tasks` only shows truncated previews, and editing from a preview wipes the existing prompt. Check the original content and `groupFolder` first. Never append blindly or wipe another group's task.

**Tasks run in a separate container**, not your current session — your container must be idle or closed first. So `schedule_task` is for *future* independent work (reminders, reports, periodic checks), not "continue this in a few seconds". Each task is single-turn: it launches, works, sends output, closes. For ongoing work in the current session, use background processes or the loop skill (the container stays alive ~30 min idle).

