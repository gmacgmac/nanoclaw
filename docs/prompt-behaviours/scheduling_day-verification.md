---
category: scheduling
default: true
---
## Day Verification

A wrong day means a wrong reminder — missed events, missed deadlines. Always verify via `date` before any day-dependent decision, even when you're sure. The cost of checking is near zero.

- Date mentioned → verify the day ("11 May" → which weekday?)
- Day mentioned → verify the date ("next Monday" → which date?)
- Your own output → confirm with `date -d "YYYY-MM-DD" +%A` before sending

After verifying the date↔day mapping: scan recurring items for that day, scan one-off items for that date, and flag any collisions or relevant context.

