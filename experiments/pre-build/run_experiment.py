"""Drain3 pre-build validation experiment.

Runs 8 phases against the generated 10K log dataset to validate Drain3's
suitability for production log template extraction.

Gated phases (must pass for GO):
  1. Template Quality — purity metric across 3 pre-processing variants
  2. Checkpoint Recovery — template ID stability across save/restore
  3. Throughput — 10K messages under 10 seconds
  5. Template Trajectory — template count growth must decelerate

Advisory phases (informational, no hard gate):
  4. Parameter Sensitivity — sim_th sweep (0.3, 0.4, 0.5)
  6. Memory Footprint — TemplateMiner state size after 10K messages
  7. Ordering Sensitivity — Jaccard similarity across shuffled inputs
  8. Edge Cases — adversarial input handling

Tested with: drain3==0.9.11

Usage:
    uv run --with drain3 python run_experiment.py [--input data/logs_10k.jsonl]
"""

import argparse
import json
import os
import pickle
import random
import re
import shutil
import sys
import tempfile
import time
from collections import Counter, defaultdict

from drain3 import TemplateMiner
from drain3.file_persistence import FilePersistence
from drain3.template_miner_config import TemplateMinerConfig

# ---------------------------------------------------------------------------
# Pre-processing variants
# ---------------------------------------------------------------------------

# Order matters: UUID/IP before digits, so digit regex doesn't mangle them
COMMON_PATTERNS = [
    (re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I), "<UUID>"),
    (re.compile(r"\b\d{1,3}(\.\d{1,3}){3}\b"), "<IP>"),
    (re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\d]*Z?"), "<TS>"),
    (re.compile(r"\b[0-9a-f]{16,}\b", re.I), "<HEX>"),
    (re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"), "<EMAIL>"),
]


def preprocess_raw(msg: str) -> str:
    return msg


def preprocess_digits(msg: str, digit_pattern: re.Pattern) -> str:
    for pattern, replacement in COMMON_PATTERNS:
        msg = pattern.sub(replacement, msg)
    msg = digit_pattern.sub("<ID>", msg)
    return msg


DIGIT_6_PLUS = re.compile(r"\b\d{6,}\b")
DIGIT_4_PLUS = re.compile(r"\b\d{4,}\b")

PREPROCESSORS = {
    "raw": preprocess_raw,
    "digit_6plus": lambda msg: preprocess_digits(msg, DIGIT_6_PLUS),
    "digit_4plus": lambda msg: preprocess_digits(msg, DIGIT_4_PLUS),
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def load_messages(path: str) -> list[dict]:
    """Load JSONL log file, return list of parsed records."""
    records = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def create_miner(persistence=None, sim_th=None) -> TemplateMiner:
    """Create a Drain3 TemplateMiner with optional config overrides."""
    config = TemplateMinerConfig()
    if sim_th is not None:
        config.drain_sim_th = sim_th
    return TemplateMiner(persistence_handler=persistence, config=config)


def cluster_messages(
    messages: list[str],
    preprocessor,
    miner: TemplateMiner | None = None,
    sim_th: float | None = None,
) -> tuple[TemplateMiner, list[int]]:
    """Cluster messages, return (miner, list_of_cluster_ids)."""
    if miner is None:
        miner = create_miner(sim_th=sim_th)

    cluster_ids = []
    for msg in messages:
        processed = preprocessor(msg)
        result = miner.add_log_message(processed)
        cluster_ids.append(result["cluster_id"])

    return miner, cluster_ids


def compute_purity(cluster_ids: list[int], family_ids: list[int]) -> float:
    """Compute average cluster purity.

    For each Drain3 cluster, find which family_id is most common.
    Purity = sum(max_family_count_per_cluster) / total_messages.
    """
    cluster_to_families: dict[int, list[int]] = defaultdict(list)
    for cid, fid in zip(cluster_ids, family_ids):
        cluster_to_families[cid].append(fid)

    correct = 0
    for fids in cluster_to_families.values():
        counts = Counter(fids)
        correct += counts.most_common(1)[0][1]

    return correct / len(cluster_ids) if cluster_ids else 0.0


def get_template_text(result: dict) -> str:
    """Extract template text from Drain3 result.

    Drain3's template_mined can be a string or an object with get_template().
    Handle both cases.
    """
    tm = result["template_mined"]
    if isinstance(tm, str):
        return tm
    return tm.get_template()


def print_header(title: str) -> None:
    width = 70
    print()
    print("=" * width)
    print(f"  {title}")
    print("=" * width)


def print_subheader(title: str) -> None:
    print(f"\n--- {title} ---")


# ---------------------------------------------------------------------------
# Phase 1: Template Quality
# ---------------------------------------------------------------------------


def phase_1_template_quality(records: list[dict]) -> tuple[bool, str, str]:
    """Test 3 pre-processing variants. Returns (passed, best_variant, details)."""
    print_header("PHASE 1: Template Quality")

    messages = [r["message"] for r in records]
    family_ids = [r["_family_id"] for r in records]

    results = {}

    for name, preprocessor in PREPROCESSORS.items():
        print_subheader(f"Variant: {name}")

        miner, cluster_ids = cluster_messages(messages, preprocessor)
        purity = compute_purity(cluster_ids, family_ids)
        clusters = miner.drain.clusters
        n_templates = len(clusters)

        results[name] = {
            "purity": purity,
            "n_templates": n_templates,
            "miner": miner,
        }

        print(f"  Unique templates: {n_templates}")
        print(f"  Purity: {purity:.4f}")

        # Top 10 templates by size
        sorted_clusters = sorted(clusters, key=lambda c: c.size, reverse=True)
        print(f"\n  Top 10 templates:")
        for c in sorted_clusters[:10]:
            print(f"    [{c.size:5d}] {c.get_template() if hasattr(c, 'get_template') else str(c)}")
        print(f"\n  Bottom 5 templates:")
        for c in sorted_clusters[-5:]:
            print(f"    [{c.size:5d}] {c.get_template() if hasattr(c, 'get_template') else str(c)}")

    # Determine best variant
    best_name = max(results, key=lambda k: results[k]["purity"])
    best_purity = results[best_name]["purity"]
    passed = best_purity >= 0.8

    print(f"\n  Best variant: {best_name} (purity={best_purity:.4f})")
    print(f"  PHASE 1: {'PASS' if passed else 'FAIL'} (threshold: 0.80)")

    return passed, best_name, f"purity={best_purity:.4f}"


# ---------------------------------------------------------------------------
# Phase 2: Checkpoint Recovery
# ---------------------------------------------------------------------------


def phase_2_checkpoint_recovery(
    records: list[dict], preprocessor, variant_name: str
) -> tuple[bool, str]:
    """Verify checkpoint preserves Drain3 state.

    Strategy: Cluster 5K messages, checkpoint, restart, then cluster the NEXT
    5K messages (5001-10000) with both the continued miner and the restored miner.
    Both should produce the same templates for unseen messages since they have
    the same learned state.
    """
    print_header("PHASE 2: Checkpoint Recovery")
    print(f"  Using variant: {variant_name}")

    first_half = [preprocessor(r["message"]) for r in records[:5000]]
    second_half = [preprocessor(r["message"]) for r in records[5000:]]
    tmpdir = tempfile.mkdtemp(prefix="drain3_checkpoint_")

    try:
        persistence_a = FilePersistence(os.path.join(tmpdir, "state_a.bin"))
        miner_a = create_miner(persistence=persistence_a)
        for msg in first_half:
            miner_a.add_log_message(msg)
        miner_a.save_state("checkpoint")

        # Get templates for second half from continued miner
        templates_from_a = []
        for msg in second_half:
            result = miner_a.add_log_message(msg)
            templates_from_a.append(get_template_text(result))

        # Restore from checkpoint into new miner
        persistence_b = FilePersistence(os.path.join(tmpdir, "state_a.bin"))
        miner_b = create_miner(persistence=persistence_b)

        # Get templates for same second half from restored miner
        templates_from_b = []
        for msg in second_half:
            result = miner_b.add_log_message(msg)
            templates_from_b.append(get_template_text(result))

        # Compare: both miners should produce same templates for unseen messages
        matches = sum(1 for a, b in zip(templates_from_a, templates_from_b) if a == b)
        total = len(second_half)
        match_rate = matches / total

        print(f"  Trained on: {len(first_half)} messages")
        print(f"  Tested on: {total} unseen messages")
        print(f"  Matching templates: {matches}/{total} ({match_rate:.2%})")

        if match_rate < 1.0:
            mismatches = [
                (i, a, b)
                for i, (a, b) in enumerate(zip(templates_from_a, templates_from_b))
                if a != b
            ]
            print(f"  First 3 mismatches:")
            for idx, t1, t2 in mismatches[:3]:
                print(f"    msg[{idx}]: '{t1}' vs '{t2}'")

        passed = match_rate >= 0.99
        print(f"  PHASE 2: {'PASS' if passed else 'FAIL'} (require: >=99%)")

        return passed, f"{matches}/{total} stable"

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Phase 3: Throughput
# ---------------------------------------------------------------------------


def phase_3_throughput(records: list[dict], preprocessor, variant_name: str) -> tuple[bool, str]:
    """Time the full pre-process + cluster pipeline for 10K messages."""
    print_header("PHASE 3: Throughput")
    print(f"  Using variant: {variant_name}")

    messages = [r["message"] for r in records]

    start = time.perf_counter()
    miner, _ = cluster_messages(messages, preprocessor)
    elapsed = time.perf_counter() - start

    rate = len(messages) / elapsed if elapsed > 0 else float("inf")

    print(f"  Messages: {len(messages)}")
    print(f"  Elapsed: {elapsed:.2f}s")
    print(f"  Rate: {rate:.0f} msg/s")

    passed = elapsed < 10.0
    print(f"  PHASE 3: {'PASS' if passed else 'FAIL'} (threshold: <10s)")

    return passed, f"{elapsed:.2f}s ({rate:.0f} msg/s)"


# ---------------------------------------------------------------------------
# Phase 4: Parameter Sensitivity (advisory)
# ---------------------------------------------------------------------------


def phase_4_parameter_sensitivity(
    records: list[dict], preprocessor, variant_name: str
) -> str:
    """Test sim_th values 0.3, 0.4, 0.5. Advisory — no hard gate."""
    print_header("PHASE 4: Parameter Sensitivity (sim_th)")
    print(f"  Using variant: {variant_name}")

    messages = [r["message"] for r in records]
    family_ids = [r["_family_id"] for r in records]

    results = {}
    for sim_th in [0.3, 0.4, 0.5]:
        miner, cluster_ids = cluster_messages(messages, preprocessor, sim_th=sim_th)
        purity = compute_purity(cluster_ids, family_ids)
        n_templates = len(miner.drain.clusters)
        results[sim_th] = (n_templates, purity)
        print(f"  sim_th={sim_th}: {n_templates} templates, purity={purity:.4f}")

    best_th = max(results, key=lambda k: results[k][1])
    print(f"\n  Recommended sim_th: {best_th} (purity={results[best_th][1]:.4f})")
    return f"best sim_th={best_th}, purity={results[best_th][1]:.4f}"


# ---------------------------------------------------------------------------
# Phase 5: Template Trajectory (gated)
# ---------------------------------------------------------------------------


def phase_5_template_trajectory(
    records: list[dict], preprocessor, variant_name: str
) -> tuple[bool, str]:
    """Track template count at each 1K messages. PASS if growth decelerates."""
    print_header("PHASE 5: Template Trajectory")
    print(f"  Using variant: {variant_name}")

    messages = [r["message"] for r in records]
    miner = create_miner()

    checkpoints = []
    for i, msg in enumerate(messages, 1):
        processed = preprocessor(msg)
        miner.add_log_message(processed)
        if i % 1000 == 0:
            n = len(miner.drain.clusters)
            checkpoints.append((i, n))
            print(f"  {i:5d} messages -> {n:3d} templates")

    # Check deceleration: compare growth in first half vs second half of checkpoints
    mid = len(checkpoints) // 2
    if len(checkpoints) >= 4 and mid > 0:
        first_segment = checkpoints[mid][1] - checkpoints[0][1]
        second_segment = checkpoints[-1][1] - checkpoints[mid][1]

        decelerated = second_segment <= first_segment
        label_first = f"1K-{checkpoints[mid][0] // 1000}K"
        label_second = f"{checkpoints[mid][0] // 1000}K-{checkpoints[-1][0] // 1000}K"
        print(f"\n  Growth {label_first}: +{first_segment} templates")
        print(f"  Growth {label_second}: +{second_segment} templates")
        print(f"  Decelerated: {decelerated}")
    else:
        first_segment = 0
        second_segment = 0
        decelerated = False
        print("\n  Not enough data points to measure deceleration")

    passed = decelerated
    print(f"  PHASE 5: {'PASS' if passed else 'FAIL'} (growth must decelerate)")

    return passed, f"first half: +{first_segment}, second half: +{second_segment}"


# ---------------------------------------------------------------------------
# Phase 6: Memory Footprint (advisory)
# ---------------------------------------------------------------------------


def phase_6_memory_footprint(
    records: list[dict], preprocessor, variant_name: str
) -> str:
    """Measure TemplateMiner state size after 10K messages."""
    print_header("PHASE 6: Memory Footprint")
    print(f"  Using variant: {variant_name}")

    messages = [r["message"] for r in records]
    miner, _ = cluster_messages(messages, preprocessor)

    # Pickle the state to measure size
    state_bytes = len(pickle.dumps(miner.drain))
    n_templates = len(miner.drain.clusters)

    print(f"  Templates: {n_templates}")
    print(f"  Drain state size: {state_bytes:,} bytes ({state_bytes / 1024:.1f} KB)")
    print(f"  Per-template avg: {state_bytes / n_templates:.0f} bytes")

    # Estimate multi-tenant impact
    for tenants in [10, 50, 100]:
        total_mb = (state_bytes * tenants) / (1024 * 1024)
        print(f"  Estimated {tenants} tenants: {total_mb:.1f} MB")

    return f"{state_bytes / 1024:.1f} KB for {n_templates} templates"


# ---------------------------------------------------------------------------
# Phase 7: Ordering Sensitivity (advisory)
# ---------------------------------------------------------------------------


def phase_7_ordering_sensitivity(
    records: list[dict], preprocessor, variant_name: str
) -> str:
    """Cluster same messages in two random orders. Compare template sets."""
    print_header("PHASE 7: Ordering Sensitivity")
    print(f"  Using variant: {variant_name}")

    messages = [r["message"] for r in records]

    # Order 1: original order
    miner1, _ = cluster_messages(messages, preprocessor)
    templates1 = {c.get_template() if hasattr(c, 'get_template') else str(c) for c in miner1.drain.clusters}

    # Order 2: shuffled (separate RNG to avoid contaminating module-level seed)
    rng = random.Random(999)
    shuffled = messages.copy()
    rng.shuffle(shuffled)
    miner2, _ = cluster_messages(shuffled, preprocessor)
    templates2 = {c.get_template() if hasattr(c, 'get_template') else str(c) for c in miner2.drain.clusters}

    # Jaccard similarity
    intersection = templates1 & templates2
    union = templates1 | templates2
    jaccard = len(intersection) / len(union) if union else 1.0

    print(f"  Order 1 templates: {len(templates1)}")
    print(f"  Order 2 templates: {len(templates2)}")
    print(f"  Shared templates: {len(intersection)}")
    print(f"  Jaccard similarity: {jaccard:.4f}")

    if jaccard >= 0.8:
        print("  Result: Order-insensitive (good)")
    else:
        print("  Result: Order-sensitive (warm-up effects likely)")

    return f"Jaccard={jaccard:.4f}"


# ---------------------------------------------------------------------------
# Phase 8: Edge Cases (advisory)
# ---------------------------------------------------------------------------


def phase_8_edge_cases(preprocessor, variant_name: str) -> str:
    """Feed adversarial inputs. Report behavior."""
    print_header("PHASE 8: Edge Cases")
    print(f"  Using variant: {variant_name}")

    edge_cases = [
        ("empty string", ""),
        ("whitespace only", "   \t  "),
        ("single character", "X"),
        ("pure numbers", "123456789012345678901234567890"),
        ("10KB message", "A" * 10240),
        ("binary-looking", "\x00\x01\x02\xff\xfe" * 20),
        ("all punctuation", "!@#$%^&*()[]{}|\\;:'\",.<>?/~`" * 5),
        ("unicode heavy", "日本語ログメッセージ ERROR: 接続タイムアウト host=db-prod"),
        ("newlines embedded", "line1\nline2\nline3"),
        ("very long tokens", "x" * 5000 + " " + "y" * 5000),
    ]

    miner = create_miner()
    results = []

    for label, msg in edge_cases:
        try:
            processed = preprocessor(msg)
            result = miner.add_log_message(processed)
            if isinstance(result, dict):
                cid = result["cluster_id"]
                tmpl = get_template_text(result)[:80]
                results.append((label, "OK", f"cluster={cid}, template='{tmpl}'"))
                print(f"  {label:25s} -> OK (cluster={cid})")
            else:
                # Drain3 returns string for some inputs (e.g. empty, too short)
                results.append((label, "SKIPPED", f"drain3 returned: {str(result)[:60]}"))
                print(f"  {label:25s} -> SKIPPED (drain3 returned non-dict)")
        except Exception as e:
            results.append((label, "ERROR", str(e)[:80]))
            print(f"  {label:25s} -> ERROR: {e!s:.60s}")

    ok_count = sum(1 for _, status, _ in results if status == "OK")
    skip_count = sum(1 for _, status, _ in results if status == "SKIPPED")
    err_count = sum(1 for _, status, _ in results if status == "ERROR")
    print(f"\n  OK: {ok_count}, Skipped by Drain3: {skip_count}, Errors: {err_count}")
    print("  Note: SKIPPED means Drain3 silently ignores the input (no crash)")

    return f"{ok_count} OK, {skip_count} skipped, {err_count} errors"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="Drain3 pre-build validation experiment")
    parser.add_argument(
        "--input",
        type=str,
        default="data/logs_10k.jsonl",
        help="Input JSONL log file",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="results/report.txt",
        help="Output report file",
    )
    args = parser.parse_args()

    # Load data
    print(f"Loading messages from {args.input}...")
    records = load_messages(args.input)
    print(f"Loaded {len(records)} records")

    # Run gated phases
    p1_passed, best_variant, p1_detail = phase_1_template_quality(records)
    best_preprocessor = PREPROCESSORS[best_variant]

    p2_passed, p2_detail = phase_2_checkpoint_recovery(records, best_preprocessor, best_variant)
    p3_passed, p3_detail = phase_3_throughput(records, best_preprocessor, best_variant)

    # Advisory phases
    p4_detail = phase_4_parameter_sensitivity(records, best_preprocessor, best_variant)

    # Gated
    p5_passed, p5_detail = phase_5_template_trajectory(records, best_preprocessor, best_variant)

    # Advisory phases
    p6_detail = phase_6_memory_footprint(records, best_preprocessor, best_variant)
    p7_detail = phase_7_ordering_sensitivity(records, best_preprocessor, best_variant)
    p8_detail = phase_8_edge_cases(best_preprocessor, best_variant)

    # Summary
    all_gates_passed = p1_passed and p2_passed and p3_passed and p5_passed
    verdict = "GO" if all_gates_passed else "NO-GO"

    summary_lines = [
        "",
        "=" * 50,
        "  PRE-BUILD VALIDATION RESULTS",
        "=" * 50,
        f"  Template Quality:    {'PASS' if p1_passed else 'FAIL':8s} ({p1_detail})",
        f"  Checkpoint Recovery: {'PASS' if p2_passed else 'FAIL':8s} ({p2_detail})",
        f"  Throughput:          {'PASS' if p3_passed else 'FAIL':8s} ({p3_detail})",
        f"  Template Trajectory: {'PASS' if p5_passed else 'FAIL':8s} ({p5_detail})",
        "-" * 50,
        f"  Parameter Sensitivity: {p4_detail}",
        f"  Memory Footprint:      {p6_detail}",
        f"  Ordering Sensitivity:  {p7_detail}",
        f"  Edge Cases:            {p8_detail}",
        "=" * 50,
        f"  OVERALL: {verdict}",
        "=" * 50,
        "",
    ]

    for line in summary_lines:
        print(line)

    # Write report
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        f.write("\n".join(summary_lines))
        f.write(f"\nBest pre-processing variant: {best_variant}\n")
        f.write(f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")

    sys.exit(0 if all_gates_passed else 1)


if __name__ == "__main__":
    main()
