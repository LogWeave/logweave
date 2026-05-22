import { randomBytes } from 'node:crypto'

/**
 * Inputs for building a CloudFormation quick-create URL for the LogWeave S3
 * connector IAM role. See services/api/cloudformation/s3-connector-role.yaml
 * for the template the URL launches.
 */
export interface QuickCreateUrlInput {
  /** AWS account ID of the LogWeave service (the trusted principal). */
  logweaveAccountId: string
  /** Public HTTPS URL of the CloudFormation template (s3.amazonaws.com or similar). */
  templateUrl: string
  /** Bucket the role should be allowed to read. */
  bucket: string
  /** Object key prefix (e.g. "logs/"). Empty string = whole bucket. */
  prefix?: string
  /** ExternalId for the trust policy (per-connector). */
  externalId: string
  /** AWS region for the CloudFormation console deep link. */
  region?: string
  /** Optional override for the IAM role name. */
  roleName?: string
  /** Optional override for the CloudFormation stack name. */
  stackName?: string
}

const DEFAULT_STACK_NAME = 'logweave-s3-connector'
const DEFAULT_REGION = 'us-east-1'

/**
 * Generate a cryptographically random ExternalId suitable for an IAM trust
 * policy. URL-safe base64, 256 bits of entropy.
 */
export function generateExternalId(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Build a CloudFormation quick-create-stack URL with the LogWeave S3 connector
 * template and all required parameters pre-filled.
 *
 * The user clicks this link, lands on the AWS Console "Create stack" page with
 * fields populated, ticks the IAM acknowledgement, and clicks Create. After
 * the stack creates, they copy the RoleArn output back into LogWeave.
 *
 * Docs: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-create-stack-quick-create-links.html
 */
export function buildQuickCreateUrl(input: QuickCreateUrlInput): string {
  if (!/^\d{12}$/.test(input.logweaveAccountId)) {
    throw new Error('logweaveAccountId must be a 12-digit AWS account ID')
  }
  if (!input.externalId || input.externalId.length < 16) {
    throw new Error('externalId must be at least 16 characters')
  }

  const region = input.region ?? DEFAULT_REGION
  const stackName = input.stackName ?? DEFAULT_STACK_NAME

  const params = new URLSearchParams()
  params.set('templateURL', input.templateUrl)
  params.set('stackName', stackName)
  params.set('param_LogWeaveAccountId', input.logweaveAccountId)
  params.set('param_ExternalId', input.externalId)
  params.set('param_BucketName', input.bucket)
  params.set('param_BucketPrefix', input.prefix ?? '')
  if (input.roleName) {
    params.set('param_RoleName', input.roleName)
  }

  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(region)}#/stacks/quickcreate?${params.toString()}`
}
