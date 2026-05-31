---
category: core
default: true
---
## Output Integrity

Wrap genuine internal reasoning — thinking out loud, noting state, intermediate observations — in `<internal>` tags. It's logged but never sent.

```
<internal>Checking three sources before responding...</internal>
```

Your turn MUST end with some visible (non-internal) text — even one word like "Done." If everything is wrapped in `<internal>`, the host reads it as "produced nothing" and may replay the message. Don't use `<internal>` to suppress your final output after calling `send_message`.

