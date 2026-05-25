# S3 connector IAM setup

LogWeave reads log files from your S3 bucket on demand when you drill into a
pattern in the dashboard. Nothing is persisted on our side — the bytes flow
through the API server, get parsed for matching lines, and the rest is
discarded.

To do that, LogWeave needs cross-account read access to a specific bucket
and prefix. We use IAM `AssumeRole` with an `ExternalId` (per-connector,
random) so:

- Your account stays in control of the role and its policy.
- LogWeave's account ID is the only trusted principal.
- The `ExternalId` prevents the [confused-deputy problem][cd] — even if
  another tenant guessed your role ARN, AssumeRole would fail.

The fastest setup is a CloudFormation **quick-create** link: one click on
your end, ~30 seconds for AWS to create the stack, then paste the Role
ARN back into LogWeave.

[cd]: https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html

## What gets created

Stack: `logweave-s3-connector` (you can rename it).

One IAM role with:

- **Trust policy**: only the LogWeave AWS account can assume it, and only
  with the matching `ExternalId`.
- **Inline policy**: `s3:ListBucket` (scoped to your prefix) and
  `s3:GetObject` (scoped to objects under that prefix).

No other permissions. No data is written. The template lives at
[services/api/cloudformation/s3-connector-role.yaml](../../services/api/cloudformation/s3-connector-role.yaml).

## Step-by-step

1. **Open LogWeave → Settings → Log Connectors → Add Connector.** Pick
   "Amazon S3" as the type.
2. Fill in **Bucket** (e.g. `acme-app-logs`), **Region** (e.g.
   `us-east-1`), and **Prefix** if your logs live under a folder
   (e.g. `production/`).
3. Click **Quick-create IAM role.** LogWeave generates a per-connector
   `ExternalId`, pre-fills it into the External ID field, and opens
   the AWS CloudFormation console in a new tab with all parameters
   already filled in.
4. In the AWS Console, scroll to the bottom, tick **"I acknowledge that
   AWS CloudFormation might create IAM resources with custom names"**,
   and click **Create stack.**
5. After the stack reaches `CREATE_COMPLETE` (~30 seconds), open the
   **Outputs** tab and copy the **RoleArn** value
   (`arn:aws:iam::123…:role/LogWeaveS3ConnectorRole`).
6. Paste the Role ARN into the **Role ARN** field in LogWeave. Set
   **Path Pattern** to match how your logs are laid out (e.g.
   `{prefix}{service}/{year}/{month}/{day}/{hour}/`), pick **Log
   Format** and **Compression**, and click **Test & Save.**
7. Click **Test** on the new connector row. You should see
   `Connected. Found N file(s)…`.

If you'd rather create the role manually, the trust and permission
policies in the CFN template are the canonical source — copy them
into the IAM console verbatim and supply the same `ExternalId` you
paste into LogWeave.

## Verifying the role works

The **Test** button in the dashboard does the smallest possible call:
`ListObjectsV2` with `MaxKeys=10` against your bucket and prefix. The
result tells you whether the AssumeRole + bucket policy chain is wired
up correctly.

Common failures:

- **Access denied** — the role's inline policy doesn't cover the prefix
  you configured. Re-check the `BucketPrefix` parameter you used when
  creating the stack.
- **No such bucket** — the bucket name is wrong or lives in a different
  partition. The role doesn't auto-cross AWS partitions.
- **AssumeRole failed: invalid ExternalId** — the External ID stored on
  the connector doesn't match the one CloudFormation used. Easiest fix:
  delete the stack, run quick-create again, and update the connector.

## Auditing access in your CloudTrail

Every AssumeRole call LogWeave makes appears in your AWS CloudTrail under
the IAM role's account. The `userIdentity.sessionContext.sessionIssuer`
points at the LogWeave role; the `requestParameters.roleSessionName`
field carries a per-(tenant, connector) identifier so you can pivot the
audit log:

```
logweave-<tenantHash>-<connectorIdSuffix>
```

- `tenantHash` is a 12-character HMAC of the LogWeave tenant ID. It's
  **not reversible** without LogWeave's server-side secret, so the
  session name alone doesn't tell an attacker who the tenant is — but
  it's stable, so you can filter CloudTrail for a specific tenant's
  activity once you know which hash maps to which tenant on the
  LogWeave side.
- `connectorIdSuffix` is the first 8 characters of the LogWeave
  connector UUID. Multiple connectors per tenant produce distinct
  session names.

Example CloudTrail filter for one specific connector:

```
eventName = AssumeRole AND
requestParameters.roleSessionName starts-with logweave-abc123def456-789abcde
```

The hash is computed with HMAC-SHA256 using LogWeave's `LOGWEAVE_ENCRYPTION_KEY`
as the secret, so the same tenant + connector always produces the same
session name across LogWeave restarts.

## Operator setup (self-hosters only)

If you run your own LogWeave instance and want the dashboard's
quick-create button to work, set two environment variables on the API
server:

```bash
LOGWEAVE_AWS_ACCOUNT_ID=123456789012   # the account LogWeave runs in
LOGWEAVE_S3_CFN_TEMPLATE_URL=https://your-bucket.s3.amazonaws.com/cfn/s3-connector-role.yaml
```

Upload `services/api/cloudformation/s3-connector-role.yaml` to any
public-readable HTTPS location (an S3 bucket with a static-website
policy is fine) and point `LOGWEAVE_S3_CFN_TEMPLATE_URL` at it.

Without these set, the dashboard's quick-create button returns a clear
error; users can still configure connectors by following the manual
path above.
