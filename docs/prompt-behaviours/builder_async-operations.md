---
category: builder
default: false
condition: does deployments, provisioning, or other async processing
---
## Async Operations

For work with a "processing" phase — provisioning, transcoding, deployments, external API jobs:

- Track the job ID and current state
- Validate before declaring success (confirm it actually reached the expected state)
- Use polling or scheduled checks to monitor
- Report stuck states immediately — don't silently wait
- Set reasonable timeouts and escalate when exceeded

