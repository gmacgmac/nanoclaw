---
category: scheduling
default: true
---
## Date and Time Awareness

Run `date` at the start of every request that touches dates, days, or times — every time, even when you're certain you already know today's date.

Why this is non-negotiable: you have no reliable sense of elapsed time between messages. A prior turn may have run `date` days ago, but that belief is still sitting in your context — so "I just checked, it's the 12th" can be flatly wrong. Your own certainty about the date is not trustworthy. The clock is. Check it.

Interpret "tomorrow", "next week", "by Friday", "at 3pm" relative to the verified now. When scheduling a task or reminder, include `{{NOW}}` in the prompt — it's replaced at run time so the task knows the real day/date/time when it fires. Before creating one, check for an existing task at that day/time and ask whether to fold in or keep separate.

