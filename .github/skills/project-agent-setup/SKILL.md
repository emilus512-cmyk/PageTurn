---
name: project-agent-setup
description: 'Explore a repository and create or update concise coding-agent instructions. Use when onboarding agents, documenting project conventions, or setting up AGENTS.md or copilot-instructions.md.'
---

# Project Agent Setup

Create or improve repository instructions that help coding agents work productively in the codebase. Only modify agent customization files; do not start implementing a software task mentioned in the request.

## Workflow

1. **Inspect existing guidance.** Look for `AGENTS.md`, `.github/copilot-instructions.md`, other agent instruction files, and project documentation. Preserve useful existing content and user changes. If instructions already exist, update them instead of creating a competing file. Otherwise, prefer a root `AGENTS.md`.
2. **Learn the local workflow.** Read the README and the smallest representative set of source files, tests, and configuration needed to identify architecture, build/test commands, conventions, and likely pitfalls. Check that proposed commands and paths actually exist. Link to relevant documentation instead of duplicating it.
3. **Use relevant history when available.** If session history tools are available, consult the Chronicle skill for repeated project-specific friction. Treat history as supporting evidence; do not invent conventions or failures.
4. **Write concise instructions.** Include only durable, actionable facts agents cannot easily infer. Prefer explicit file ownership, verified commands, and concrete conventions. Avoid generic advice, repeated documentation, and speculative requirements.
5. **Validate and report.** Confirm the chosen file path, ensure the guidance matches the repository, and report added or changed customization files in a short table with why each helps. Suggest a relevant follow-up customization and invite corrections to uncertain assumptions.

## Scope and Decisions

- Keep exploration read-only until there is enough evidence to draft instructions.
- Do not edit application code, tests, build configuration, or product documentation as part of this workflow.
- Use a single root instruction file for a small repository. Consider scoped instructions or a dedicated skill only when the codebase has distinct areas or a genuinely repeatable specialized workflow.
- If no meaningful project conventions can be verified, keep the instruction file minimal rather than filling it with general coding guidance.