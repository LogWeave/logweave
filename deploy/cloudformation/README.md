# LogWeave on AWS — CloudFormation

Two-stack deploy that puts LogWeave behind HTTPS at a domain you own.
~10 minutes end-to-end. No SSH, no manual server config, no secrets in
CloudFormation parameters.

## What you get

- Single EC2 instance (default `t3.large`, ~$60/month) running ClickHouse,
  the LogWeave API, and the Drain3 clusterer in Docker
- 50 GB encrypted gp3 EBS volume for ClickHouse data (`DeletionPolicy: Snapshot`)
- Stable Elastic IP
- Auto-renewed Let's Encrypt cert via Caddy
- Secrets generated once and stored in Secrets Manager (KMS-encrypted)
- SSM Session Manager only — no port 22 exposed

Total monthly cost in `us-east-1` on-demand: ~**$65 + data transfer**.

## Stack layout

| Stack | Lifetime | Resources |
|---|---|---|
| `network.yml` | Long-lived. Holds your data and identity. | EIP, EBS volume, Secrets Manager secret, IAM role, instance profile |
| `app.yml`     | Disposable. Recreate to upgrade or change instance type. | EC2 instance, security group, EIP/volume attachments, wait condition |

The split exists for three reasons:

1. **DNS chicken-and-egg** — the EIP is created by `network.yml` before
   `app.yml` runs, so you can update DNS first and Caddy gets its cert on
   the first try.
2. **Secret hygiene** — secrets never appear as CloudFormation parameters
   or in user-data. The instance reads them at boot via its IAM role.
3. **Safe rebuilds** — deleting `app.yml` and re-creating it (e.g. to
   upgrade to a new AMI or change instance type) leaves your data and EIP
   untouched.

## Deploy

You'll need an AWS account with a default VPC, plus a domain you control
the DNS for.

### 1. Network stack (~30 seconds)

```
aws cloudformation deploy \
  --stack-name logweave-network \
  --template-file deploy/cloudformation/network.yml \
  --parameter-overrides AvailabilityZone=us-east-1a \
  --capabilities CAPABILITY_IAM
```

Pick any AZ — the app stack must launch into the same one. Then read the
EIP from outputs:

```
aws cloudformation describe-stacks \
  --stack-name logweave-network \
  --query 'Stacks[0].Outputs[?OutputKey==`ElasticIp`].OutputValue' \
  --output text
```

### 2. Update DNS

At your registrar / DNS provider, create an `A` record pointing your
chosen domain at the EIP. Wait for propagation:

```
dig +short logs.example.com
```

Both `1.1.1.1` and `8.8.8.8` should return the EIP. If they don't, the
app stack will fail fast with an actionable error message — but waiting
saves you a 2-minute round trip.

### 3. App stack (~8 minutes)

```
aws cloudformation deploy \
  --stack-name logweave-app \
  --template-file deploy/cloudformation/app.yml \
  --parameter-overrides \
      NetworkStackName=logweave-network \
      DomainName=logs.example.com \
      AdminEmail=you@example.com \
  --capabilities CAPABILITY_IAM
```

When `CREATE_COMPLETE`, your dashboard is at `https://<DomainName>`. The
HTTPS cert may take an extra 30-60s to acquire after stack completion.

### 4. First login

The bootstrap admin password is generated randomly on the instance and
written to the API container log. Retrieve it:

```
INSTANCE_ID=$(aws cloudformation describe-stacks \
  --stack-name logweave-app \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text)

aws ssm start-session --target $INSTANCE_ID
# then on the box:
sudo docker logs $(sudo docker ps -qf name=api) 2>&1 | grep -i 'default admin'
```

Username `admin`, password from the log line. You will be forced to
change it on first login.

## Operations

### Upgrade

The app stack pulls `:latest` from GHCR on every fresh launch. To pull
the latest images on an existing stack:

```
aws ssm start-session --target $INSTANCE_ID
sudo docker compose -f /opt/logweave/docker-compose.prod.yml pull
sudo docker compose -f /opt/logweave/docker-compose.prod.yml up -d
```

For a clean rebuild (new AMI, different instance type, fresh OS):

```
aws cloudformation delete-stack --stack-name logweave-app
# wait for delete
aws cloudformation deploy --stack-name logweave-app ...
```

The EIP, EBS volume, and Secrets Manager values are preserved by the
network stack. Your dashboard and data come back as soon as the new
instance boots.

### Restrict access

`AllowedCidr` defaults to `0.0.0.0/0` because Let's Encrypt's HTTP-01
challenge needs port 80 reachable from the internet. After the first
cert is issued, you can narrow it:

```
aws cloudformation deploy \
  --stack-name logweave-app \
  --template-file deploy/cloudformation/app.yml \
  --parameter-overrides \
      ... \
      AllowedCidr=203.0.113.0/24
```

Note: cert renewals (every ~60 days) require port 80 reachable from
public Let's Encrypt ACME servers. Either widen `AllowedCidr` before the
renewal window or switch Caddy to DNS-01 (manual change to `Caddyfile`).

### Tear down

```
aws cloudformation delete-stack --stack-name logweave-app
aws cloudformation delete-stack --stack-name logweave-network
```

The EBS volume is preserved as a snapshot (per `DeletionPolicy: Snapshot`).
You'll see it in the EC2 console under Snapshots.

## Troubleshooting

### Stack rolls back at `WaitCondition`

Means user-data signalled `FAILURE` or never signalled. SSM into the
instance and read the log:

```
aws ssm start-session --target $INSTANCE_ID
sudo cat /var/log/logweave-init.log | tail -100
```

Look for `STEP=...` markers. The most common failures:

- **`STEP=dns-precheck`** — your domain doesn't resolve to the EIP yet.
  Wait for DNS, then `delete-stack` + re-deploy. Network stack and data
  untouched.
- **`STEP=install-caddy`** — Caddy SHA512 mismatch. The pinned version
  in `app.yml` doesn't match what GitHub served. Bump `CADDY_VERSION`
  and `CADDY_SHA512` together (checksums file is at
  `https://github.com/caddyserver/caddy/releases/download/v<version>/caddy_<version>_checksums.txt`).
- **`STEP=wait-healthz`** — API never came up. Check `docker logs` of
  the api / clickhouse / clusterer containers on the instance.

### `CREATE_COMPLETE` but `https://...` is unreachable

Caddy obtains the cert in the background after the stack signals. Wait
30-60s. If still nothing, on the instance:

```
sudo journalctl -u caddy --no-pager | tail -50
```

If Let's Encrypt is rate-limiting (5 failed attempts per hour on a given
domain), wait an hour. The most common cause is bad DNS during the first
boot; fix DNS, restart Caddy with `sudo systemctl restart caddy`.

### Need to reset the bootstrap password

If you didn't capture the bootstrap password and you can't log in:

```
sudo docker logs $(sudo docker ps -qf name=api) 2>&1 | grep -i 'default admin'
```

If the log has rotated, the password is gone for good. Either restore
from snapshot, or:

1. Empty `/data/clickhouse/dashboard_users` on the box (destroys all
   user accounts)
2. Restart the api container — it'll bootstrap a new admin and print
   the new password

```
sudo docker compose -f /opt/logweave/docker-compose.prod.yml restart api
```

## What's NOT included

- **Multi-AZ / HA** — single instance, single AZ. EBS snapshots are your
  DR story.
- **ALB / autoscaling** — defer until needed. ClickHouse on a single
  EBS volume scales to ~100M events/day; well past first-customer scope.
- **Route53** — manage your own DNS at any registrar.
- **S3 connector IAM** — separate quick-create template (see `#147`).
- **In-place updates via `cfn-hup`** — upgrades go through SSM +
  `docker compose pull`, not template updates.

## Pre-launch caveat

Until the repo transfers to the `LogWeave` GitHub org, GHCR images live
under `ghcr.io/robertdicker/*`. The compose file in `app.yml` reflects
this. After repo transfer, the namespace flips to `ghcr.io/logweave/*`
and `app.yml` will be re-pointed.
