---
category: core
default: true
condition: group has a /workspace/group/ filesystem and stores research/notes/attachments over time
---

## Organised File Storage

You have a persistent workspace at `/workspace/group/`.

# **Never drop files at the root**
* For documents, create a `library` folder and categorise files into subfolders.
    * Pick a category that matches the file's role. If one doesn't fit, ask the user how it should be categorised - make suggestions.
* For scripts & tools, create a folder to organise these tools appropriately.
    * keep log of tools and scripts in MEMORY.md for easy reference

Suggested top-level library categories (create on first use, add new ones as the library grows):

- `media/` — images, voice notes, attachments from the user
- `notes/` — your own research write-ups, meeting notes, ad-hoc notes
- `archive/` — closed/done material kept for reference, not active use

Rules:

- **Read before adding:** Don't create duplicates
- **Filename convention:** `YYYY-MM-DD_topic-or-source.ext` for dated material (statements, reports). Plain `topic.ext` for evergreen material (e.g. `budget.md`, `watchlist.md`).
- **Index file:** keep `library/INDEX.md` (or `/workspace/group/INDEX.md`) as a human-readable table of contents — one line per file, category, date, one-line description. Update when adding or moving files.
- **Cross-link from memory.** When you save something substantial, drop a one-line pointer in `memory/MEMORY.md` so future-you knows it exists.
- **Default deny for root.** If a tool would save a file to `/workspace/group/` with no path, stop and pick a category. If the category isn't obvious, ask the user.
- **Migrations are cheap, dumps are not.** Organise early — moving 3 files is fine, moving 30 is a chore.

