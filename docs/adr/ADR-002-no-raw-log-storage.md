# ADR-002: No Raw Log Storage

**Status:** Accepted
**Date:** 2026-03-13

## Context

Traditional log platforms (CloudWatch, Datadog, Splunk) store raw log content and
charge primarily for ingestion and storage volume. This creates cost scaling problems
for customers and compliance burdens (HIPAA, GDPR, PCI) for us as the platform operator.

LogWeave's core thesis is that most value comes from patterns, not raw content.

## Decision

Never store raw log content. Store only: template patterns, occurrence counts,
extracted field statistics, anomaly scores, and source pointers (where to find the
original log in the customer's infrastructure). Raw logs are either kept in the
customer's existing system (CloudWatch, Model B) or routed to their S3 bucket (Model C).

The only exception: `pre_processed_message` column in `log_metadata` is temporarily
populated for unclustered rows (template_id=0) to enable recovery. It is nulled after
successful re-clustering.

## Consequences

- **Positive:** No compliance burden for raw content. 50-80% cost savings for customers
  via S3 routing. Architecture is inherently simpler — less data to store and secure.
- **Negative:** "Explain this error" features require fetching raw logs on-demand from
  the customer's source (NoneAdapter in MVP, real adapters in Phase 2).
- **Constraint:** Every code path that touches log content must discard it after
  processing. Code review must flag any persistent storage of raw content.
