"""Generate 10K realistic log messages for the Drain3 pre-build experiment.

Produces JSONL output with ground-truth _family_id for quality measurement.
No external dependencies — stdlib only.

Usage:
    python generate_logs.py [--count 10000] [--output data/logs_10k.jsonl]
"""

import argparse
import json
import random
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone

# Seed for reproducibility
random.seed(42)

# --- Services ---
SERVICES = ["payment-service", "user-service", "api-gateway", "notification-service"]

# --- Hosts, IPs, routes, etc. for filler values ---
DB_HOSTS = ["db-prod", "db-replica-1", "db-replica-2", "db-analytics"]
CACHE_KEYS = [
    "user:profile:{}",
    "session:{}",
    "rate:limit:{}",
    "product:catalog:{}",
    "cart:{}",
]
ROUTES = [
    "/api/v1/users",
    "/api/v1/payments",
    "/api/v1/orders",
    "/api/v1/products",
    "/api/v1/auth/login",
    "/api/v1/auth/refresh",
    "/api/v1/notifications",
    "/api/v1/health",
    "/api/v1/webhooks/stripe",
    "/api/v2/search",
]
HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"]
STATUS_CODES_OK = [200, 201, 204]
STATUS_CODES_CLIENT_ERR = [400, 401, 403, 404, 422, 429]
STATUS_CODES_SERVER_ERR = [500, 502, 503]
STRIPE_EVENTS = [
    "payment_intent.succeeded",
    "payment_intent.failed",
    "charge.refunded",
    "invoice.paid",
    "customer.subscription.updated",
]
EMAIL_DOMAINS = ["example.com", "test.org", "acme.co", "demo.io"]
EXCEPTION_CLASSES = [
    "NullPointerException",
    "TypeError",
    "ValueError",
    "ConnectionError",
    "TimeoutError",
    "AuthenticationError",
]
JAVA_CLASSES = [
    "UserService.getUser",
    "PaymentProcessor.charge",
    "OrderService.create",
    "AuthMiddleware.verify",
    "DatabasePool.getConnection",
    "CacheManager.get",
    "NotificationDispatcher.send",
]


def rand_ip():
    return f"{random.randint(10, 192)}.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}"


def rand_uuid():
    return str(uuid.uuid4())


def rand_hex(length=32):
    return uuid.uuid4().hex[:length]


def rand_email():
    name = random.choice(["alice", "bob", "charlie", "diana", "eve", "frank"])
    domain = random.choice(EMAIL_DOMAINS)
    return f"{name}{random.randint(1, 999)}@{domain}"


def rand_duration_fast():
    return round(random.uniform(0.5, 50), 1)


def rand_duration_normal():
    return round(random.uniform(10, 500), 1)


def rand_duration_slow():
    return round(random.uniform(500, 15000), 1)


def rand_port():
    return random.choice([5432, 3306, 6379, 8080, 8443, 9200, 27017])


def rand_large_id():
    return random.randint(100000, 99999999)


# --- Template Families ---
# Each family: (family_id, format_fn, weight, service, level, extra_fields_fn)
# format_fn returns (message, extra_fields)

TEMPLATE_FAMILIES = [
    # ===== HIGH VOLUME (health checks, request logs, heartbeats) =====
    # Family 1: Health check OK — api-gateway
    (
        1,
        lambda: (
            f"Health check endpoint responded with status 200 in {random.randint(1, 15)}ms",
            {"status_code": 200, "duration_ms": random.uniform(1, 15), "route": "/api/v1/health"},
        ),
        500,
        "api-gateway",
        "DEBUG",
    ),
    # Family 2: Health check OK — payment-service
    (
        2,
        lambda: (
            f"Health check passed: database={random.choice(['ok', 'ok', 'ok', 'ok', 'degraded'])}"
            f" cache={random.choice(['ok', 'ok', 'ok', 'ok', 'miss'])} uptime={random.randint(1000, 999999)}s",
            {"status_code": 200, "route": "/health"},
        ),
        400,
        "payment-service",
        "DEBUG",
    ),
    # Family 3: Health check OK — user-service
    (
        3,
        lambda: (
            f"Liveness probe succeeded in {random.randint(1, 10)}ms",
            {"status_code": 200, "route": "/healthz"},
        ),
        350,
        "user-service",
        "DEBUG",
    ),
    # Family 4: HTTP request completed (2xx)
    (
        4,
        lambda: (
            (
                route := random.choice(ROUTES),
                method := random.choice(HTTP_METHODS),
                status := random.choice(STATUS_CODES_OK),
                dur := rand_duration_normal(),
            )
            and f"{method} {route} {status} {dur}ms - {rand_ip()} - trace_id={rand_uuid()}",
            {
                "status_code": status,
                "duration_ms": dur,
                "route": route,
                "trace_id": rand_uuid(),
            },
        ),
        600,
        lambda: random.choice(["api-gateway", "payment-service", "user-service"]),
        "INFO",
    ),
    # Family 5: HTTP request completed (4xx)
    (
        5,
        lambda: (
            (
                route := random.choice(ROUTES),
                method := random.choice(HTTP_METHODS),
                status := random.choice(STATUS_CODES_CLIENT_ERR),
                dur := rand_duration_normal(),
            )
            and f"{method} {route} {status} {dur}ms - {rand_ip()} - trace_id={rand_uuid()}",
            {
                "status_code": status,
                "duration_ms": dur,
                "route": route,
                "trace_id": rand_uuid(),
            },
        ),
        150,
        lambda: random.choice(["api-gateway", "payment-service", "user-service"]),
        "WARN",
    ),
    # Family 6: Heartbeat received
    (
        6,
        lambda: (
            f"Heartbeat received from worker-{random.randint(1, 8)}"
            f" pid={random.randint(10000, 65000)} uptime={random.randint(100, 500000)}s",
            {},
        ),
        300,
        lambda: random.choice(SERVICES),
        "DEBUG",
    ),
    # Family 7: Cache hit
    (
        7,
        lambda: (
            (key := random.choice(CACHE_KEYS).format(rand_large_id()),)
            and f"Cache HIT for key={key} ttl={random.randint(60, 3600)}s",
            {"duration_ms": rand_duration_fast()},
        ),
        400,
        lambda: random.choice(["user-service", "payment-service"]),
        "DEBUG",
    ),
    # Family 8: Cache miss
    (
        8,
        lambda: (
            (key := random.choice(CACHE_KEYS).format(rand_large_id()),)
            and f"Cache MISS for key={key} - fetching from database",
            {"duration_ms": rand_duration_normal()},
        ),
        200,
        lambda: random.choice(["user-service", "payment-service"]),
        "DEBUG",
    ),
    # Family 9: Database query completed
    (
        9,
        lambda: (
            (dur := rand_duration_normal(),)
            and f"Query completed on {random.choice(DB_HOSTS)}:{rand_port()}"
            f" rows={random.randint(0, 500)} duration={dur}ms",
            {"duration_ms": dur},
        ),
        350,
        lambda: random.choice(["payment-service", "user-service"]),
        "DEBUG",
    ),
    # Family 10: Request started
    (
        10,
        lambda: (
            (route := random.choice(ROUTES), method := random.choice(HTTP_METHODS))
            and f"Incoming request {method} {route} from {rand_ip()} request_id={rand_uuid()}",
            {"route": route, "trace_id": rand_uuid()},
        ),
        500,
        "api-gateway",
        "INFO",
    ),
    # ===== MEDIUM VOLUME =====
    # Family 11: Authentication success
    (
        11,
        lambda: (
            f"Authentication successful for user_id={rand_large_id()}"
            f" email={rand_email()} method=jwt",
            {"route": "/api/v1/auth/login"},
        ),
        80,
        "user-service",
        "INFO",
    ),
    # Family 12: Authentication failure
    (
        12,
        lambda: (
            f"Authentication failed for email={rand_email()}"
            f" reason={random.choice(['invalid_password', 'expired_token', 'invalid_token', 'account_locked'])}"
            f" ip={rand_ip()}",
            {"status_code": 401, "route": "/api/v1/auth/login"},
        ),
        40,
        "user-service",
        "WARN",
    ),
    # Family 13: Rate limit warning
    (
        13,
        lambda: (
            f"Rate limit approaching for tenant_id={rand_large_id()}"
            f" current={random.randint(800, 980)}/1000 window=60s endpoint={random.choice(ROUTES)}",
            {"status_code": 429},
        ),
        30,
        "api-gateway",
        "WARN",
    ),
    # Family 14: Rate limit exceeded
    (
        14,
        lambda: (
            f"Rate limit exceeded for tenant_id={rand_large_id()}"
            f" limit=1000 window=60s ip={rand_ip()}",
            {"status_code": 429},
        ),
        15,
        "api-gateway",
        "ERROR",
    ),
    # Family 15: Slow query warning
    (
        15,
        lambda: (
            (dur := rand_duration_slow(),)
            and f"Slow query detected on {random.choice(DB_HOSTS)}"
            f" duration={dur}ms threshold=1000ms"
            f" query_hash={rand_hex(16)}",
            {"duration_ms": dur},
        ),
        25,
        lambda: random.choice(["payment-service", "user-service"]),
        "WARN",
    ),
    # Family 16: Connection pool exhaustion
    (
        16,
        lambda: (
            f"Connection pool near exhaustion:"
            f" active={random.randint(18, 20)}/20"
            f" waiting={random.randint(1, 10)}"
            f" host={random.choice(DB_HOSTS)}:{rand_port()}",
            {},
        ),
        20,
        lambda: random.choice(["payment-service", "user-service"]),
        "WARN",
    ),
    # Family 17: External API call — Stripe
    (
        17,
        lambda: (
            (dur := rand_duration_normal(),)
            and f"Stripe API call: POST /v1/payment_intents"
            f" status=200 duration={dur}ms"
            f" idempotency_key={rand_uuid()}",
            {"duration_ms": dur},
        ),
        60,
        "payment-service",
        "INFO",
    ),
    # Family 18: Stripe webhook received
    (
        18,
        lambda: (
            f"Stripe webhook received: event={random.choice(STRIPE_EVENTS)}"
            f" id=evt_{rand_hex(24)}",
            {"route": "/api/v1/webhooks/stripe"},
        ),
        40,
        "payment-service",
        "INFO",
    ),
    # Family 19: Session created
    (
        19,
        lambda: (
            f"Session created for user_id={rand_large_id()}"
            f" session_id={rand_uuid()} ttl=3600s ip={rand_ip()}",
            {},
        ),
        50,
        "user-service",
        "INFO",
    ),
    # Family 20: Session expired
    (
        20,
        lambda: (
            f"Session expired: session_id={rand_uuid()}"
            f" user_id={rand_large_id()} reason=ttl_exceeded",
            {},
        ),
        30,
        "user-service",
        "INFO",
    ),
    # Family 21: Email notification sent
    (
        21,
        lambda: (
            f"Notification sent: type={random.choice(['welcome', 'password_reset', 'order_confirmation', 'payment_receipt'])}"
            f" to={rand_email()} provider=sendgrid"
            f" message_id={rand_uuid()} duration={rand_duration_normal()}ms",
            {},
        ),
        35,
        "notification-service",
        "INFO",
    ),
    # Family 22: Notification delivery failed
    (
        22,
        lambda: (
            f"Notification delivery failed: to={rand_email()}"
            f" error={random.choice(['bounce', 'invalid_address', 'provider_timeout', 'rate_limited'])}"
            f" attempts={random.randint(1, 3)} message_id={rand_uuid()}",
            {},
        ),
        10,
        "notification-service",
        "ERROR",
    ),
    # Family 23: Deployment started
    (
        23,
        lambda: (
            f"Deployment started: version={random.randint(1, 5)}.{random.randint(0, 30)}.{random.randint(0, 99)}"
            f" commit={rand_hex(7)} environment=production",
            {},
        ),
        5,
        lambda: random.choice(SERVICES),
        "INFO",
    ),
    # Family 24: Deployment completed
    (
        24,
        lambda: (
            f"Deployment completed: version={random.randint(1, 5)}.{random.randint(0, 30)}.{random.randint(0, 99)}"
            f" duration={random.randint(30, 180)}s status=success",
            {},
        ),
        5,
        lambda: random.choice(SERVICES),
        "INFO",
    ),
    # Family 25: Background job completed
    (
        25,
        lambda: (
            f"Job completed: job_id={rand_uuid()}"
            f" type={random.choice(['cleanup_expired_sessions', 'aggregate_metrics', 'send_daily_digest', 'sync_inventory'])}"
            f" duration={random.randint(100, 30000)}ms records_processed={random.randint(10, 50000)}",
            {},
        ),
        40,
        lambda: random.choice(SERVICES),
        "INFO",
    ),
    # Family 26: Configuration reloaded
    (
        26,
        lambda: (
            f"Configuration reloaded: source={random.choice(['env', 'configmap', 'vault'])}"
            f" keys_updated={random.randint(1, 5)}",
            {},
        ),
        10,
        lambda: random.choice(SERVICES),
        "INFO",
    ),
    # ===== LOW VOLUME (errors, rare events) =====
    # Family 27: Connection timeout to database
    (
        27,
        lambda: (
            (host := random.choice(DB_HOSTS), port := rand_port(), dur := rand_duration_slow())
            and f"Connection timeout to {host}:{port} after {dur}ms",
            {"duration_ms": dur},
        ),
        8,
        lambda: random.choice(["payment-service", "user-service"]),
        "ERROR",
    ),
    # Family 28: NullPointerException / TypeError
    (
        28,
        lambda: (
            (exc := random.choice(EXCEPTION_CLASSES), cls := random.choice(JAVA_CLASSES))
            and f"{exc} at {cls}(line:{random.randint(10, 500)}):"
            f" Cannot read property '{random.choice(['id', 'email', 'amount', 'status', 'token'])}' of null"
            f" trace_id={rand_uuid()}",
            {"trace_id": rand_uuid()},
        ),
        12,
        lambda: random.choice(["payment-service", "user-service"]),
        "ERROR",
    ),
    # Family 29: HTTP 5xx response
    (
        29,
        lambda: (
            (
                route := random.choice(ROUTES),
                method := random.choice(HTTP_METHODS),
                status := random.choice(STATUS_CODES_SERVER_ERR),
                dur := rand_duration_slow(),
            )
            and f"{method} {route} {status} {dur}ms - {rand_ip()}"
            f" error=\"Internal Server Error\" trace_id={rand_uuid()}",
            {
                "status_code": status,
                "duration_ms": dur,
                "route": route,
                "trace_id": rand_uuid(),
            },
        ),
        20,
        lambda: random.choice(["api-gateway", "payment-service", "user-service"]),
        "ERROR",
    ),
    # Family 30: OOM killed
    (
        30,
        lambda: (
            f"Process killed: out of memory."
            f" RSS={random.randint(500, 2000)}MB limit={random.choice([512, 1024, 2048])}MB"
            f" pid={random.randint(10000, 65000)}",
            {},
        ),
        2,
        lambda: random.choice(SERVICES),
        "ERROR",
    ),
    # Family 31: Deadlock detected
    (
        31,
        lambda: (
            f"Deadlock detected on {random.choice(DB_HOSTS)}:"
            f" table={random.choice(['users', 'payments', 'orders', 'inventory'])}"
            f" waiting_txn={rand_hex(8)} blocking_txn={rand_hex(8)}"
            f" duration={random.randint(5000, 30000)}ms",
            {},
        ),
        3,
        lambda: random.choice(["payment-service", "user-service"]),
        "ERROR",
    ),
    # Family 32: TLS certificate expiring
    (
        32,
        lambda: (
            f"TLS certificate expiring: host={random.choice(['api.example.com', 'db-prod.internal', 'cache.internal'])}"
            f" days_remaining={random.randint(1, 14)}"
            f" serial={rand_hex(16)}",
            {},
        ),
        3,
        "api-gateway",
        "WARN",
    ),
    # Family 33: Disk usage warning
    (
        33,
        lambda: (
            f"Disk usage warning: mount={random.choice(['/data', '/var/log', '/tmp'])}"
            f" used={random.randint(85, 98)}%"
            f" available={random.randint(1, 15)}GB",
            {},
        ),
        4,
        lambda: random.choice(SERVICES),
        "WARN",
    ),
    # Family 34: Circuit breaker opened
    (
        34,
        lambda: (
            f"Circuit breaker OPEN for {random.choice(['stripe-api', 'sendgrid-api', 'db-primary', 'cache-cluster'])}:"
            f" failures={random.randint(5, 20)} threshold=5"
            f" reset_timeout=30s",
            {},
        ),
        5,
        lambda: random.choice(SERVICES),
        "ERROR",
    ),
    # Family 35: Circuit breaker closed
    (
        35,
        lambda: (
            f"Circuit breaker CLOSED for {random.choice(['stripe-api', 'sendgrid-api', 'db-primary', 'cache-cluster'])}:"
            f" recovered after {random.randint(30, 120)}s",
            {},
        ),
        5,
        lambda: random.choice(SERVICES),
        "INFO",
    ),
    # Family 36: DNS resolution failure
    (
        36,
        lambda: (
            f"DNS resolution failed for {random.choice(['stripe.com', 'api.sendgrid.com', 'db-prod.internal', 'cache.internal'])}:"
            f" NXDOMAIN after {random.randint(1, 3)} retries",
            {},
        ),
        3,
        lambda: random.choice(SERVICES),
        "ERROR",
    ),
    # Family 37: Stripe API error
    (
        37,
        lambda: (
            f"Stripe API error: status={random.choice([400, 402, 500, 503])}"
            f" type={random.choice(['card_error', 'api_error', 'rate_limit_error', 'authentication_error'])}"
            f" charge_id=ch_{rand_hex(24)}",
            {},
        ),
        10,
        "payment-service",
        "ERROR",
    ),
    # Family 38: User account action
    (
        38,
        lambda: (
            f"Account {random.choice(['created', 'updated', 'deactivated', 'reactivated'])}:"
            f" user_id={rand_large_id()}"
            f" ip={rand_ip()}"
            f" user_agent=Mozilla/5.0",
            {},
        ),
        20,
        "user-service",
        "INFO",
    ),
    # Family 39: Graceful shutdown
    (
        39,
        lambda: (
            f"Graceful shutdown initiated: signal=SIGTERM"
            f" in_flight_requests={random.randint(0, 15)}"
            f" drain_timeout=30s",
            {},
        ),
        3,
        lambda: random.choice(SERVICES),
        "INFO",
    ),
    # Family 40: Service started
    (
        40,
        lambda: (
            f"Service started: version={random.randint(1, 5)}.{random.randint(0, 30)}.{random.randint(0, 99)}"
            f" port={random.choice([3000, 8000, 8080])}"
            f" environment=production"
            f" node_id={rand_hex(8)}",
            {},
        ),
        4,
        lambda: random.choice(SERVICES),
        "INFO",
    ),
    # Family 41: Memory usage warning
    (
        41,
        lambda: (
            f"Memory usage high: heap_used={random.randint(400, 900)}MB"
            f" heap_total={random.choice([512, 1024])}MB"
            f" rss={random.randint(500, 1100)}MB"
            f" gc_pause={random.randint(50, 500)}ms",
            {},
        ),
        6,
        lambda: random.choice(SERVICES),
        "WARN",
    ),
    # Family 42: Retry attempt
    (
        42,
        lambda: (
            f"Retry attempt {random.randint(1, 3)}/3 for"
            f" {random.choice(['stripe-api', 'sendgrid-api', 'db-query', 'cache-write'])}:"
            f" previous_error={random.choice(['timeout', 'connection_refused', '503_service_unavailable'])}"
            f" backoff={random.choice([1000, 2000, 4000])}ms",
            {},
        ),
        15,
        lambda: random.choice(SERVICES),
        "WARN",
    ),
]


def generate_timestamp(base: datetime, index: int, total: int) -> str:
    """Generate timestamps spread across a 24-hour window, roughly chronological."""
    offset_seconds = (index / total) * 86400 + random.uniform(-30, 30)
    ts = base + timedelta(seconds=offset_seconds)
    return ts.strftime("%Y-%m-%dT%H:%M:%S.") + f"{random.randint(0, 999):03d}Z"


def generate_logs(count: int, output_path: str) -> None:
    families = TEMPLATE_FAMILIES
    family_ids = [f[0] for f in families]
    weights = [f[2] for f in families]

    # Select which family each message comes from
    selected = random.choices(range(len(families)), weights=weights, k=count)

    base_time = datetime(2026, 3, 12, 0, 0, 0, tzinfo=timezone.utc)

    records = []
    for i, idx in enumerate(selected):
        family_id, format_fn, _weight, service, level = families[idx]

        # Resolve callable services
        if callable(service):
            service = service()

        message, extra_fields = format_fn()
        timestamp = generate_timestamp(base_time, i, count)

        record = {
            "timestamp": timestamp,
            "service": service,
            "level": level,
            "message": message,
            "_family_id": family_id,
        }

        # Add optional fields if present
        for field in ["status_code", "duration_ms", "trace_id", "route"]:
            if field in extra_fields:
                record[field] = extra_fields[field]
                # Round duration_ms for cleanliness
                if field == "duration_ms" and record[field] is not None:
                    record[field] = round(record[field], 1)

        records.append(record)

    # Sort by timestamp for realism
    records.sort(key=lambda r: r["timestamp"])

    # Write JSONL
    with open(output_path, "w", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    # Print summary
    service_counts = Counter(r["service"] for r in records)
    level_counts = Counter(r["level"] for r in records)
    family_counts = Counter(r["_family_id"] for r in records)

    print(f"Generated {len(records)} log messages -> {output_path}")
    print(f"\nBy service:")
    for svc, cnt in service_counts.most_common():
        print(f"  {svc:30s} {cnt:5d} ({cnt/len(records)*100:.1f}%)")
    print(f"\nBy level:")
    for lvl, cnt in level_counts.most_common():
        print(f"  {lvl:30s} {cnt:5d} ({cnt/len(records)*100:.1f}%)")
    print(f"\nTemplate families used: {len(family_counts)} / {len(families)}")
    print(f"\nTop 10 families by count:")
    for fid, cnt in family_counts.most_common(10):
        print(f"  family_{fid:02d}: {cnt:5d}")
    print(f"\nBottom 5 families by count:")
    for fid, cnt in family_counts.most_common()[-5:]:
        print(f"  family_{fid:02d}: {cnt:5d}")


def main():
    parser = argparse.ArgumentParser(description="Generate realistic log messages for Drain3 experiment")
    parser.add_argument("--count", type=int, default=10000, help="Number of log messages to generate")
    parser.add_argument(
        "--output", type=str, default="data/logs_10k.jsonl", help="Output file path (JSONL)"
    )
    args = parser.parse_args()

    generate_logs(args.count, args.output)


if __name__ == "__main__":
    main()
