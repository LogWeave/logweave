# Security Policy

## Reporting a Vulnerability

LogWeave is beta software run by a small team. If you believe you have found a security vulnerability, please report it privately so we can address it before public disclosure.

**Preferred channel:** GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) — open the repository's **Security** tab and click **Report a vulnerability**.

Please include:

- A description of the issue and the impact
- Steps to reproduce, or a proof-of-concept
- The affected component (`services/api`, `services/clusterer`, `services/mcp`, `services/dashboard`, `@logweave/transport`, etc.) and version or commit SHA
- Any suggested remediation, if you have one

**Please do not** open a public GitHub issue, post in discussions, or share the details on social media before we have had a chance to investigate.

## What to Expect

- We will acknowledge receipt within **5 business days**.
- We will provide an assessment of the report (accepted, needs more info, or not a vulnerability) within **14 days**.
- For accepted reports, we will work with you on a coordinated disclosure timeline. Default target: a fix released within **90 days** of acknowledgement, with public disclosure shortly after.

## Scope

In scope:

- The LogWeave application code in this repository (API, clusterer, MCP server, dashboard, transport SDK).
- Published artifacts: `@logweave/mcp`, `@logweave/transport`, and any published Docker images under the `logweave` org.

Out of scope:

- Third-party dependencies — please report those to the upstream project. We will pick up patched versions during normal dependency updates.
- Self-hosted deployments where the operator has not followed the documented installation guide (e.g. running with default-changed env vars, public ClickHouse with no auth, etc.).
- Denial-of-service via volume of legitimate ingest traffic — LogWeave has documented rate limits; tuning is an operator responsibility.

## Beta Caveat

LogWeave is **public beta software**. We do not currently offer security guarantees or SLAs. See [TERMS.md](TERMS.md) for the full beta terms. We take security reports seriously regardless.
