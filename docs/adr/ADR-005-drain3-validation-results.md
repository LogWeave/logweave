# ADR-005: Drain3 Pre-Build Validation Results

**Status:** Accepted
**Date:** 2026-03-13
**Deciders:** Solo maintainer

## Context

Before building the clusterer service, PLAN.md requires validating that Drain3 produces
useful log templates. This experiment tested Drain3 against 10,000 synthetic log messages
across 42 template families and 4 services.

## Decision

**GO — proceed with Drain3 for production clustering.**

## Validation Results

All 4 gated phases passed:

- **Template Quality:** 0.99 purity (raw), 0.96 purity (with pre-processing)
- **Checkpoint Recovery:** 99.86% template stability across restart
- **Throughput:** 223,886 msg/s (10K messages in 0.04s)
- **Template Trajectory:** Growth decelerates (80 templates at 1K, 113 at 10K)
- **Memory Footprint:** 12.4 KB for 113 templates (~1.2 MB for 100 tenants)
- **Edge Cases:** All 10 adversarial inputs handled without crashes

## Production Configuration

Based on experiment findings:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `sim_th` | 0.4 (default) | Best purity. 0.3 over-merges, 0.5 over-splits |
| Pre-processing | digit_6plus + UUID/IP/TS/HEX/EMAIL | Lower purity on synthetic data, but essential for real high-cardinality logs |
| Checkpoint interval | 60s | Drain3 state is tiny (12 KB), frequent saves have no cost |

## Consequences

- Clusterer service (Week 1a) can proceed with Drain3 as the clustering engine
- Pre-processing pipeline should use the `\d{6,}` variant with named replacements
- Production should validate with real customer logs during onboarding — synthetic
  data doesn't cover all real-world patterns
- Drain3's ordering sensitivity (Jaccard 0.8387) is acceptable but means the first
  few hundred messages during warm-up will produce slightly different templates than
  a fully-trained model. The graduated alert threshold (10x for first 60 min) already
  accounts for this.

## Full Results

Run `uv run --with drain3 python experiments/pre-build/run_experiment.py` to reproduce.
Results are generated locally in `experiments/pre-build/results/summary.md`.
