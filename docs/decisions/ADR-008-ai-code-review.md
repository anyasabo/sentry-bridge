# ADR-008: AI-Powered Code Review Tooling

## Status

Accepted

## Context and Problem Statement

SentryBridge is a public open-source project maintained by a small team. Pull requests are reviewed manually today. As the codebase grows (TypeScript/Node.js backend, React frontend, Docker, GitHub Actions CI), manual review becomes a bottleneck for catching security issues, logic bugs, and TypeScript anti-patterns before merge.

The goal is to add automated AI-powered code review that runs on every PR without incurring cost, without leaking source code to unauthorized third parties, and without adding significant maintenance overhead.

## Decision Drivers

- **Zero cost** for a public OSS repository — no paid seats, no per-PR quota that would block normal workflow.
- **GitHub PR integration** — inline bot comments on PRs without requiring a separate review step.
- **TypeScript / Node.js support** — must understand the language semantics, not just produce generic LLM output.
- **Minimal setup overhead** — small team, no dedicated DevOps. Setup must complete in under an hour.
- **Acceptable privacy posture** — source code must not be stored post-review; vendor must be transparent.
- **Long-term OSS commitment** — free tier must not be a temporary acquisition tactic.

## Considered Options

### Option 1: CodeRabbit (Managed SaaS)

- Free forever for all public repositories, full Pro feature set.
- GitHub App install; no CI YAML changes required.
- Reviews every PR automatically: inline comments, summary, security scan, test coverage hints, 40+ linters (ESLint, TypeScript-aware).
- Code disposed after review; no persistent storage. SOC2 Type II, GDPR compliant.
- Explicit $1M OSS pledge; not a marketing free tier.
- No self-hosted option. Cloud-only.

### Option 2: Sourcery (Managed SaaS)

- Free for public/OSS repositories, full Pro feature set.
- GitHub App, optional `.sourcery.yaml` config.
- Strong TypeScript refactoring analysis; security scanning limited to 3 repos and biweekly frequency on free tier.
- No code storage; LLM providers (Anthropic) hold zero-retention agreements.
- Self-hosted requires Enterprise contract — not realistic for this project.

### Option 3: PR-Agent / Qodo (Self-Hosted via GitHub Actions)

- Fully open-source (`qodo-ai/pr-agent`); bring-your-own LLM API key (Anthropic Claude, OpenAI, local Ollama).
- Deployed as a GitHub Actions workflow; code only reaches the configured LLM provider — no third-party SaaS.
- Quality depends on the chosen model; Claude Sonnet gives high-quality reviews at low cost (cents per PR).
- Setup requires ~20 lines of GitHub Actions YAML and two repository secrets.
- Highest privacy guarantee; no vendor dependency beyond the LLM provider.

### Option 4: Qodo Merge (Managed SaaS)

- 30 free PR reviews per month; credit-based system limits premium model usage.
- The monthly cap is a workflow risk for any active sprint. Rejected due to quota constraints.

### Option 5: GitHub Copilot Code Review

- Not available on Copilot Free; requires Copilot Pro ($10/mo) or higher.
- Excluded: introduces a recurring cost with no OSS exception documented.

### Option 6: Ellipsis (Managed SaaS)

- Free for public repositories. Strong feature set including auto-generated fix PRs.
- YC-backed startup (W24); long-term free-tier commitment for OSS is not explicitly guaranteed.
- Data handling policy less transparent than CodeRabbit or Sourcery.

## Decision Outcome

**Chosen: Option 1 — CodeRabbit**

CodeRabbit best satisfies all decision drivers:

1. **No cost, no PR quota** — the 4 PR/hour rate limit is not a constraint for a project of this size.
2. **Turnkey GitHub integration** — GitHub App install, no CI changes. Reviews trigger automatically on every PR.
3. **Best TypeScript review quality** — 40+ linters, security SAST, test coverage hints, and inline fix suggestions.
4. **Transparent privacy posture** — code is not stored after review; SOC2 Type II, GDPR compliant, opt-out for metadata caching.
5. **Durable OSS commitment** — explicit $1M pledge to OSS maintainers, not a limited-time promotion.

### Fallback

If CodeRabbit becomes unavailable, restricts its free OSS tier, or if the project's privacy requirements change, **PR-Agent (self-hosted)** is the designated fallback. It requires adding one GitHub Actions workflow file and two repository secrets (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`). Cost is negligible (cents per PR at Claude Sonnet rates).

## Consequences

### Positive

- Every PR receives a structured automated review before human review begins.
- Security issues, TypeScript anti-patterns, and missing test coverage are surfaced automatically.
- No CI pipeline changes required; CodeRabbit operates independently of GitHub Actions.
- Reviewers spend less time on mechanical issues and more on architecture and intent.

### Negative

- Dependency on a third-party SaaS vendor for a part of the review workflow.
- No self-hosted option means code transits CodeRabbit's infrastructure on every PR (mitigated by no-storage policy and SOC2 certification).
- Bot comments increase PR noise; requires tuning `.coderabbit.yaml` to suppress low-signal rules.

## Implementation Notes

1. Install the CodeRabbit GitHub App from `https://coderabbit.ai` and authorize it for the `reneleban/sentry-bridge` repository.
2. Add `.coderabbit.yaml` to the repository root to configure review scope, ignored paths, and tone.
3. Disable any overlapping linter-only tools (e.g. raw ESLint bot) to avoid duplicate comments.
4. Review the first 3–5 automated PR reviews and tune the config accordingly.

## References

- [CodeRabbit Pricing](https://www.coderabbit.ai/pricing)
- [CodeRabbit OSS Commitment](https://www.coderabbit.ai/blog/we-are-committed-to-supporting-open-source-distributed-600000-to-open-source-maintainers-in-2025)
- [CodeRabbit Privacy Policy](https://www.coderabbit.ai/privacy-policy)
- [PR-Agent GitHub](https://github.com/qodo-ai/pr-agent)
- [Sourcery Pricing](https://www.sourcery.ai/pricing)
