---
name: repo-customization-guide
description: 'Create or update AGENTS.md, .github/copilot-instructions.md, and project skills after reviewing the repo. Use for onboarding AI coding agents, documenting workflow, and codifying repo-specific conventions.'
argument-hint: 'Project area, workflow, or repo convention to document'
user-invocable: true
disable-model-invocation: false
---

# Repository Customization Guide

## When to Use
- The project needs AI-ready guidance for coding agents.
- You need to record project conventions, build/test commands, and key files.
- You want to create or improve `AGENTS.md`, `.github/copilot-instructions.md`, or a reusable skill.
- A repo has no onboarding instructions and you want to make future agent work faster and more consistent.

## Goal
Turn a codebase into a quick-start instruction set for future AI agents without duplicating existing docs. Prefer a short, actionable file that points to the real sources of truth.

## Procedure

### 1. Discover existing conventions
Look for current guidance in the repo before creating anything new:
- `AGENTS.md`
- `AGENT.md`
- `CLAUDE.md`
- `.github/copilot-instructions.md`
- `.cursorrules`
- `.windsurfrules`
- `.clinerules`
- `README.md`
- `CONTRIBUTING.md`
- `ARCHITECTURE.md`
- docs and rules folders

If any exist, merge into them instead of creating duplicate files.

### 2. Inspect the repo with a narrow lens
Focus on useful, stable facts that reduce agent friction:
- How the project is structured and what the main entry points are
- Build, lint, test, or validation commands
- Common developer workflows and conventions
- Domain-specific rules or gotchas
- Key directories, files, and patterns that appear repeatedly

Do not bulk-copy documentation. Link to canonical docs when they already exist.

### 3. Preserve the important conventions
Prefer a minimal instructions file that contains only what a coding agent would otherwise have to rediscover each session.

Good content includes:
- essential repo overview
- how to run the project or relevant checks
- file organization rules
- patterns for edits and validation
- explicit warnings about common mistakes

Bad content includes:
- repeating the README verbatim
- duplicating long tutorials
- vague generic advice unrelated to the repository

### 4. Draft a concise customization file
Use the repo's preferred pattern:
- Prefer `AGENTS.md` at the repo root when no instructions file exists.
- Use `.github/copilot-instructions.md` if the repo already expects that convention.
- If the workflow is specialized or reusable, create a skill in `.github/skills/<name>/SKILL.md`.

A good customization file usually includes:
1. a short project summary
2. the most relevant commands
3. key folders and entry points
4. brief rules for changes and validation
5. links to canonical docs instead of copied prose

### 5. Validate the result
Before finishing, check that the inserted guidance is:
- accurate to the codebase
- concise enough to stay useful
- not redundant with existing docs
- specific enough to guide behavior without overloading context

### 6. Iterate if the repo is complex
If the project is large or has multiple subsystems, consider splitting guidance by concern instead of making one overloaded instruction file.

Examples:
- backend instructions
- frontend instructions
- testing instructions
- release or deployment notes

## Completion Checklist
A customization file is ready when all of these are true:
- it reflects the actual repo structure
- it documents the real validation workflow
- it avoids duplication of long docs
- it gives actionable guidance to an AI agent
- it is brief and easy to maintain

## Examples of good prompts
- "Create AGENTS.md for this repo based on the current project structure."
- "Document the project-specific build and validation commands in a concise instructions file."
- "Add a project skill for onboarding AI agents to this codebase."
- "Update the repo guidelines to reflect the real architecture and testing workflow."

## Related customizations
- `AGENTS.md` or `.github/copilot-instructions.md` for repo-wide guidance
- `.github/skills/<name>/SKILL.md` for repeatable workflows
- custom prompt files for frequent tasks
- hooks for deterministic project checks when needed

## Principle
Link, don't embed. Keep customizations short, actionable, and grounded in the existing repository reality.
