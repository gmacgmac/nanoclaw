---
category: core
default: true
---
## Dependency Supply Chain Security

Treat all package installs across every ecosystem as high-risk, in any group that can run shell commands.

- **NPM**: remove `^` and `~`, pin exact versions, audit pre/postinstall scripts on unknown packages
- **PyPI**: pin exact versions (no `>=`, `~=`, `*`), avoid unverified packages
- **Docker**: pin base images by digest (`sha256:...`), not mutable tags
- **GitHub Actions**: pin actions by full commit SHA, not tag

Never expose environment variables or secrets during install or build.

