import type { DbClient } from './client.js'
import { tenantQuery } from './queries.js'

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface ConnectorRow {
  tenant_id: string
  connector_id: string
  name: string
  type: string
  config: string
  created_at: string
  updated_at: string
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const INSERT_CONNECTOR = `
INSERT INTO logweave.tenant_connectors
  (tenant_id, connector_id, name, type, config, created_at, updated_at)
VALUES
  ({tenant_id:String}, {connector_id:String}, {name:String}, {type:String}, {config:String}, now64(3), now64(3))`

const LIST_CONNECTORS = `
SELECT tenant_id, connector_id, name, type, config, created_at, updated_at
FROM logweave.tenant_connectors FINAL
WHERE tenant_id = {tenant_id:String}
ORDER BY created_at DESC`

const GET_CONNECTOR = `
SELECT tenant_id, connector_id, name, type, config, created_at, updated_at
FROM logweave.tenant_connectors FINAL
WHERE tenant_id = {tenant_id:String}
  AND connector_id = {connector_id:String}`

const DELETE_CONNECTOR = `
ALTER TABLE logweave.tenant_connectors DELETE
WHERE tenant_id = {tenant_id:String}
  AND connector_id = {connector_id:String}`

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export async function insertConnector(
  db: DbClient,
  tenantId: string,
  params: {
    connectorId: string
    name: string
    type: string
    config: string
  },
): Promise<void> {
  await db.command(
    tenantQuery(INSERT_CONNECTOR, tenantId, {
      connector_id: params.connectorId,
      name: params.name,
      type: params.type,
      config: params.config,
    }),
  )
}

export async function listConnectors(
  db: DbClient,
  tenantId: string,
): Promise<ConnectorRow[]> {
  return db.query<ConnectorRow>(tenantQuery(LIST_CONNECTORS, tenantId))
}

export async function getConnector(
  db: DbClient,
  tenantId: string,
  connectorId: string,
): Promise<ConnectorRow | undefined> {
  const rows = await db.query<ConnectorRow>(
    tenantQuery(GET_CONNECTOR, tenantId, { connector_id: connectorId }),
  )
  return rows[0]
}

export async function deleteConnector(
  db: DbClient,
  tenantId: string,
  connectorId: string,
): Promise<void> {
  await db.command(
    tenantQuery(DELETE_CONNECTOR, tenantId, { connector_id: connectorId }),
  )
}
