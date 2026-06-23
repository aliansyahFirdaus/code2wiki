# AGENT.md

# Mandatory Agent Skills
These rules are mandatory for every agent working in this repo:

1. Always use the Caveman skill family according to function:
   - `caveman` for concise, low-token technical communication.
   - `caveman-commit` for commit message generation.
   - `caveman-review` for pull request or diff review comments.
   - Any other `caveman-*` skill must be used when its described function matches the task.
2. Always use `andrej-karpathy-skill` when writing, reviewing, debugging, or refactoring code. Make assumptions explicit, keep implementations simple, make surgical changes only, and define a verifiable success check before calling work done.
3. Always use `phonytail`

# Mandatory MCP Usage / Plugin
These rules are mandatory for every agent working in this repo:

1. Always use `Context7` `(ctx7)` MCP when confused about a library, framework, SDK, API, CLI, cloud service, or when introducing a new tool/pattern. Fetch current docs and base best-practice decisions on official/current documentation rather than memory.