import type { DbClient } from './client.js'
import { tenantQuery } from './queries.js'

export interface DeployRow {
  deploy_id: string
  tenant_id: string
  service: string
  version: string | null
  commit_sha: string | null
  timestamp: string
}

export async function insertDeploy(
  db: DbClient,
  deploy: {
    deployId: string
    tenantId: string
    service: string
    version?: string
    commitSha?: string
    timestamp: string
  },
): Promise<void> {
  await db.insert({
    table: 'logweave.deploys',
    values: [
      {
        deploy_id: deploy.deployId,
        tenant_id: deploy.tenantId,
        service: deploy.service,
        version: deploy.version ?? null,
        commit_sha: deploy.commitSha ?? null,
        timestamp: deploy.timestamp,
      },
    ],
    format: 'JSONEachRow',
  })
}

export async function queryDeploys(
  db: DbClient,
  tenantId: string,
  options?: { service?: string; limit?: number },
): Promise<DeployRow[]> {
  const limit = Math.min(Math.max(1, options?.limit ?? 10), 50)
  const service = options?.service
  const serviceFilter = service ? 'AND service = {service:String}' : ''

  const query = `
SELECT deploy_id, tenant_id, service, version, commit_sha, timestamp
FROM logweave.deploys
WHERE tenant_id = {tenant_id:String}
  ${serviceFilter}
ORDER BY timestamp DESC
LIMIT {limit:UInt32}`

  const params: Record<string, unknown> = { limit }
  if (service) params.service = service

  return db.query<DeployRow>(tenantQuery(query, tenantId, params))
}

export async function queryDeployById(
  db: DbClient,
  tenantId: string,
  deployId: string,
): Promise<DeployRow | undefined> {
  const query = `
SELECT deploy_id, tenant_id, service, version, commit_sha, timestamp
FROM logweave.deploys
WHERE tenant_id = {tenant_id:String}
  AND deploy_id = {deploy_id:String}
LIMIT 1`

  const rows = await db.query<DeployRow>(tenantQuery(query, tenantId, { deploy_id: deployId }))
  return rows[0]
}
