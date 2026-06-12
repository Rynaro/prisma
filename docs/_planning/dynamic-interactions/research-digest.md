# Research Digest — Dynamic Bot Interactions

Date: 2026-06-12. Inputs: web research (LLM review UX, GitHub review UX, GitHub App UX) + codebase scout. Feeds the SPECTRA spec for the "dynamic interactions" feature.

## 1. LLM code-review UX — state of the art

**Comment mentions are the industry-standard control channel.** CodeRabbit (the UX leader in this space) drives everything through `@coderabbitai <command>` in PR comments ([command reference](https://docs.coderabbit.ai/guides/commands)):

| Command | Behavior |
|---|---|
| `review` | **Incremental** review — only what changed since last review round |
| `full review` | Fresh review of the whole PR, ignoring prior rounds |
| `pause` / `resume` | Toggle automated reviews for this PR |
| `resolve` | Mark all of the bot's prior comments resolved |
| `summary` | Regenerate the PR summary |
| `configuration` | Print effective repo config |
| `help` | Quick-reference of commands |

Key UX details:
- **Incremental vs full is the core distinction.** Incremental reviews carry context from prior rounds (don't repeat resolved feedback); full reviews start clean. This is exactly the "retries / new review rounds" ask.
- **Threaded follow-ups**: replying to a bot comment with a mention continues the conversation in-thread. GitHub Copilot's *lack* of this is its most-cited weakness ([community discussion](https://github.com/orgs/community/discussions/166504)).
- **Acknowledgment matters**: best practice is an immediate 👀 reaction (or short reply) on the command comment so the user knows the bot heard them, then ✅/🚀 when done. Note: reactions do **not** trigger webhooks, so they're safe to use as status signals ([discussion](https://github.com/orgs/community/discussions/20824)).

## 2. Signal vs noise — the #1 DX risk

Research and practitioner posts converge: **60–80% of AI review comments are perceived as noise**, and teams mute bots that repeat themselves ([Jet Xu's signal/noise framework](https://dev.to/jet_xu/drowning-in-ai-code-review-noise-a-framework-to-measure-signal-vs-noise-304e), [Why 80% of AI Code Reviews Are Just Noise](https://dev.to/synthaicode_commander/why-80-of-ai-code-reviews-are-just-noise-4i0o), [Addy Osmani, Code Review in the Age of AI](https://addyo.substack.com/p/code-review-in-the-age-of-ai)).

Implications for re-review rounds:
- A new round must **not repeat findings already posted** — diff-aware, round-aware reviews.
- Every comment should clear the bar "worth interrupting flow"; fewer, higher-confidence findings beat coverage.
- Better feedback = state *what changed in this round* ("3 of 5 prior findings addressed, 1 new issue") — round summaries are high-signal.

## 3. GitHub-native controls

- `issue_comment` (created) is the canonical event for PR-comment commands; PR review-thread replies arrive as `pull_request_review_comment` — handling both makes mention commands work everywhere ([GitHub Docs: webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [building a webhook-responding app](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-github-app-that-responds-to-webhook-events)).
- `pull_request.review_requested`: re-requesting the bot's review via GitHub's native reviewers UI should trigger a new round — this is the "GitHub controls" channel and requires zero new user vocabulary.
- `pull_request.synchronize` (new pushes) is how incremental bots know a round boundary.
- Mention parsing best practice: match the bot login (and aliases) at/near the start of the comment body, parse the remainder as `command [args]`; ignore comments authored by bots (loop prevention); verify HMAC on the raw body with timing-safe compare.
- **Permissions**: gate state-changing commands (pause/resume/resolve) to users with write access; read-only commands (help, review) can be open.

## 4. DX that makes Prisma stand out

- **Nickname/personality**: no mainstream review bot lets repos *nickname* the bot — Renovate/Dependabot offer deep config but zero personality customization. A `nickname:` key in the existing repo guidance config (PR #9 infrastructure) that (a) adds a mention alias and (b) flavors the bot's voice in summaries is a genuine differentiator, cheap to build on the config loader we already ship.
- **Honest round feedback**: explicitly diffing rounds ("addressed / still open / new") is rare and loved.
- **`help` + `configuration` commands**: discoverability is DX — users should never need the docs to learn the vocabulary.
- **Graceful degradation**: unknown command → friendly help reply, not silence.

## 5. Decisions handed to planning

1. Command channel: `@<bot-login|nickname> <command>` on `issue_comment` + `pull_request_review_comment`.
2. Initial vocabulary: `review` (incremental), `full review`, `help`, `configuration`; stretch: `pause`/`resume`, `resolve`.
3. GitHub control: **`check_run.rerequested`** ⇒ new review round. (Corrected after verification: arbitrary GitHub App bots do not appear in the PR reviewers dropdown — Copilot is special-cased — so `review_requested` is not reliable. The bot already posts an "AI Code Review" check run; GitHub's native "Re-run" button on that check sends `check_run.rerequested` to the creating app — see [check_run webhook docs](https://docs.github.com/en/webhooks/webhook-events-and-payloads#check_run). This is the zero-vocabulary GitHub-native control.)
4. Ack protocol: 👀 on receipt, ✅/comment on completion, friendly error reply on failure; retries with backoff for provider failures.
5. Round model: review rounds tracked per PR (commit-SHA anchored), incremental by default, with a round summary that diffs against prior rounds.
6. Nickname: optional repo-config key; alias for mentions + voice flavor. Never overrides safety/loop-prevention (bot still ignores bot-authored comments).

Sources: [CodeRabbit commands](https://docs.coderabbit.ai/guides/commands) · [GitHub webhook events & payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) · [Building a GitHub App that responds to webhooks](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-github-app-that-responds-to-webhook-events) · [Copilot follow-up discussion](https://github.com/orgs/community/discussions/166504) · [Reactions webhook discussion](https://github.com/orgs/community/discussions/20824) · [Signal vs noise framework](https://dev.to/jet_xu/drowning-in-ai-code-review-noise-a-framework-to-measure-signal-vs-noise-304e) · [AI review noise](https://dev.to/synthaicode_commander/why-80-of-ai-code-reviews-are-just-noise-4i0o) · [Addy Osmani — Code Review in the Age of AI](https://addyo.substack.com/p/code-review-in-the-age-of-ai) · [Renovate config docs](https://docs.renovatebot.com/configuration-options/) · [Mediator bot study (arXiv:2208.01624)](https://arxiv.org/pdf/2208.01624)
