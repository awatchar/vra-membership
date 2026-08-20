# AGENTS.md

This file is the repository contract for every human or AI agent. More specific `AGENTS.md` files may add rules for a subtree but may not weaken the security and privacy rules here.

## Before changing files

1. Read the assigned Issue, its parent/dependencies, this file, and the affected documentation.
2. Work from one scoped Issue. If the work cannot be reviewed as one coherent PR, split it first.
3. Claim the intended paths in the Issue or PR before editing. Use a separate branch and worktree per agent.
4. Check `git status` and preserve changes made by others. Never reset, overwrite, or revert unrelated work.
5. Do not open or copy local credential files under `api/**/apiendpoint-apikey.md` unless the Issue explicitly requires credential rotation by an authorized human.

## Non-negotiable security and privacy rules

- Never commit secrets, real credentials, `.dev.vars`, PII, production data, ID-card images, payment-slip images, or raw provider responses.
- Never persist a full Thai ID-card image or payment-slip image. Process it in memory and discard it.
- Persist only the member photo explicitly selected by the applicant, in private R2 storage with a random object key.
- Never log citizen IDs, names, addresses, contact data, images, form payloads, OCR results, or provider payloads.
- Keep provider credentials server-side in Cloudflare Secrets. Automated tests must use mocks and must not call production providers.
- Treat changes to authentication, authorization, payment, webhooks, encryption, retention, migrations, or deployment as high risk and request human review.

## Work and handoff protocol

- GitHub Issues are the source of truth for scope, ownership, decisions, dependencies, and blockers.
- Branch names use `<type>/issue-<number>-<short-slug>`, where type is `feat`, `fix`, `docs`, `test`, `refactor`, or `chore`.
- Prefer Conventional Commit subjects and keep commits reviewable.
- Open a Draft PR early. Link it with `Closes #<number>` only when the PR fully satisfies that Issue; otherwise use `Refs #<number>`.
- Record durable decisions in `docs/`; record transient progress and handoffs in the Issue or PR, not in new ad-hoc files.
- A handoff must state completed work, remaining work, files changed, commands and results, risks, assumptions, and the next safe action.
- Do not merge your own high-risk PR without human review.

## Verification

Run the repository baseline before every PR:

```powershell
pwsh -NoLogo -NoProfile -File ./scripts/validate-repository.ps1
```

When an application manifest exists, run the exact install, lint, typecheck, test, and build commands documented in `README.md` and defined in that manifest. Do not invent or silently skip commands. Report every command and result in the PR.

## Definition of done

- Acceptance criteria are satisfied and the PR contains no unrelated changes.
- Tests cover changed behavior and all required checks pass.
- Documentation, examples, migrations, rollback notes, and `.env.example` are updated when relevant.
- Security/privacy impact and deployment risk are explicitly assessed.
- The PR is reviewable, linked to its Issue, and includes a complete handoff.
