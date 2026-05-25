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
  version: string
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const INSERT_CONNECTOR = `
INSERT INTO logweave.tenant_connectors
  (tenant_id, connector_id, name, type, config, created_at, version, is_deleted)
VALUES
  ({tenant_id:String}, {connector_id:String}, {name:String}, {type:String}, {config:String}, now64(3), {version:UInt64}, 0)`

const LIST_CONNECTORS = `
SELECT tenant_id, connector_id, name, type, config, created_at, version
FROM logweave.tenant_connectors FINAL
WHERE tenant_id = {tenant_id:String}
  AND is_deleted = 0
ORDER BY created_at DESC`

const GET_CONNECTOR = `
SELECT tenant_id, connector_id, name, type, config, created_at, version
FROM logweave.tenant_connectors FINAL
WHERE tenant_id = {tenant_id:String}
  AND connector_id = {connector_id:String}
  AND is_deleted = 0`

// Tombstone delete: insert a row with is_deleted=1 and version > current
const DELETE_CONNECTOR = `
INSERT INTO logweave.tenant_connectors
  (tenant_id, connector_id, name, type, config, created_at, version, is_deleted)
VALUES
  ({tenant_id:String}, {connector_id:String}, '', '', '', now64(3), {version:UInt64}, 1)`

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
      version: Date.now(),
    }),
  )
}

export async function listConnectors(db: DbClient, tenantId: string): Promise<ConnectorRow[]> {
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
    tenantQuery(DELETE_CONNECTOR, tenantId, {
      connector_id: connectorId,
      version: Date.now(),
    }),
  )
}
