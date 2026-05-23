import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  useConnectors,
  useCreateConnector,
  useDeleteConnector,
  useS3QuickCreateUrl,
  useTestConnector,
} from '../../api/queries'
import type { ConnectorType } from '../../api/types'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { cn } from '../../lib/cn'
import { clearDraft, loadDraft, saveDraft } from './connector-draft'

// ---------------------------------------------------------------------------
// Type labels
// ---------------------------------------------------------------------------

const TYPE_OPTIONS: Array<{ value: ConnectorType; label: string }> = [
  { value: 's3', label: 'Amazon S3 / MinIO' },
  { value: 'elasticsearch', label: 'Elasticsearch / OpenSearch' },
  { value: 'loki', label: 'Grafana Loki' },
  { value: 'filesystem', label: 'Local Filesystem' },
]

function typeLabel(type: ConnectorType): string {
  return TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type
}

// ---------------------------------------------------------------------------
// Dynamic form fields per connector type
// ---------------------------------------------------------------------------

interface FieldDef {
  key: string
  label: string
  placeholder: string
  type?: 'text' | 'password'
  required?: boolean
}

const S3_FIELDS: FieldDef[] = [
  { key: 'bucket', label: 'Bucket', placeholder: 'my-log-bucket', required: true },
  { key: 'prefix', label: 'Prefix', placeholder: 'logs/' },
  { key: 'pathPattern', label: 'Path Pattern', placeholder: '{prefix}{service}/{year}/{month}/{day}/{hour}/', required: true },
  { key: 'region', label: 'Region', placeholder: 'us-east-1', required: true },
  { key: 'roleArn', label: 'Role ARN (recommended)', placeholder: 'arn:aws:iam::123456789012:role/LogWeaveS3ConnectorRole' },
  { key: 'externalId', label: 'External ID', placeholder: 'paste from quick-create' },
  { key: 'endpoint', label: 'Endpoint (MinIO/dev)', placeholder: 'http://minio:9002' },
  { key: 'accessKeyId', label: 'Access Key ID', placeholder: 'minioadmin', type: 'password' },
  { key: 'secretAccessKey', label: 'Secret Access Key', placeholder: '', type: 'password' },
]

const ES_FIELDS: FieldDef[] = [
  { key: 'url', label: 'URL', placeholder: 'https://elasticsearch:9200', required: true },
  { key: 'index', label: 'Index', placeholder: 'logs-*', required: true },
  { key: 'username', label: 'Username', placeholder: 'elastic' },
  { key: 'password', label: 'Password', placeholder: '', type: 'password' },
  { key: 'apiKey', label: 'API Key (alt)', placeholder: '', type: 'password' },
  { key: 'messageField', label: 'Message Field', placeholder: 'message (default)' },
  { key: 'timestampField', label: 'Timestamp Field', placeholder: '@timestamp (default)' },
]

const LOKI_FIELDS: FieldDef[] = [
  { key: 'url', label: 'URL', placeholder: 'http://loki:3100', required: true },
  { key: 'streamSelector', label: 'Stream Selector', placeholder: '{app="payments"}', required: true },
  { key: 'orgId', label: 'Org ID (multi-tenant)', placeholder: 'tenant-1' },
  { key: 'username', label: 'Username', placeholder: '' },
  { key: 'password', label: 'Password', placeholder: '', type: 'password' },
]

const FS_FIELDS: FieldDef[] = [
  { key: 'basePath', label: 'Base Path', placeholder: '/var/log/myapp', required: true },
  { key: 'filePattern', label: 'File Pattern', placeholder: '*.log', required: true },
]

function fieldsForType(type: ConnectorType): FieldDef[] {
  switch (type) {
    case 's3': return S3_FIELDS
    case 'elasticsearch': return ES_FIELDS
    case 'loki': return LOKI_FIELDS
    case 'filesystem': return FS_FIELDS
  }
}

// ---------------------------------------------------------------------------
// ConnectorSettings
// ---------------------------------------------------------------------------

export function ConnectorSettings() {
  const { data: connectorsResponse } = useConnectors()
  const connectors = connectorsResponse?.data ?? []
  const createMutation = useCreateConnector()
  const deleteMutation = useDeleteConnector()
  const testMutation = useTestConnector()
  const quickCreateMutation = useS3QuickCreateUrl()

  const [showAddForm, setShowAddForm] = useState(false)
  const [connectorName, setConnectorName] = useState('')
  const [connectorType, setConnectorType] = useState<ConnectorType>('s3')
  const [formValues, setFormValues] = useState<Record<string, string>>({})
  const [restoredFromDraft, setRestoredFromDraft] = useState(false)

  // A draft is "active" only when it contains a generated ExternalId — that's
  // the irrecoverable bit. Other form input lost on tab-close is not worth
  // guarding against.
  const draftActive = connectorType === 's3' && !!formValues.externalId?.trim()

  // Hydrate from a stored draft whenever the form opens or the type changes.
  // Only S3 has a generated secret today; if other types grow one, broaden this.
  useEffect(() => {
    if (!showAddForm || connectorType !== 's3') {
      setRestoredFromDraft(false)
      return
    }
    const draft = loadDraft(connectorType)
    if (!draft) {
      setRestoredFromDraft(false)
      return
    }
    setFormValues(draft.formValues)
    if (draft.name) setConnectorName(draft.name)
    setRestoredFromDraft(true)
  }, [showAddForm, connectorType])

  // Warn on tab close while a draft holds an ExternalId. The native confirm
  // is the standard primitive here — one click to dismiss, only fires when
  // there's actually something to lose.
  useEffect(() => {
    if (!draftActive) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Most browsers ignore the custom string and show their own copy, but
      // setting returnValue is still required to trigger the prompt.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [draftActive])

  const resetForm = () => {
    setConnectorName('')
    setConnectorType('s3')
    setFormValues({})
    setShowAddForm(false)
    setRestoredFromDraft(false)
  }

  const handleStartOver = () => {
    clearDraft(connectorType)
    setFormValues({})
    setRestoredFromDraft(false)
  }

  const handleCreate = () => {
    if (!connectorName.trim()) {
      toast.error('Name is required')
      return
    }

    const fields = fieldsForType(connectorType)
    for (const field of fields) {
      if (field.required && !formValues[field.key]?.trim()) {
        toast.error(`${field.label} is required`)
        return
      }
    }

    const config: Record<string, unknown> = { type: connectorType }
    for (const field of fields) {
      const value = formValues[field.key]?.trim()
      if (value) {
        config[field.key] = value
      }
    }

    // Add S3-specific defaults
    if (connectorType === 's3') {
      config.logFormat = formValues.logFormat || 'jsonl'
      config.compression = formValues.compression || 'none'
      if (config.endpoint) {
        config.forcePathStyle = true
      }
    }

    // Add filesystem-specific defaults
    if (connectorType === 'filesystem') {
      config.logFormat = formValues.logFormat || 'text'
    }

    createMutation.mutate(
      { name: connectorName.trim(), config },
      {
        onSuccess: () => {
          toast.success(`Connector "${connectorName}" created`)
          clearDraft(connectorType)
          resetForm()
        },
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : 'Failed to create connector'),
      },
    )
  }

  const handleTest = (connectorId: string, name: string) => {
    testMutation.mutate(connectorId, {
      onSuccess: (result) => {
        const data = result?.data
        if (data?.success) {
          toast.success(`${name}: ${data.message}`)
        } else {
          toast.error(`${name}: ${data?.message ?? 'Test failed'}`)
        }
      },
      onError: () => toast.error(`Failed to test ${name}`),
    })
  }

  const handleQuickCreate = () => {
    const bucket = formValues.bucket?.trim()
    const region = formValues.region?.trim() || 'us-east-1'
    if (!bucket) {
      toast.error('Enter the S3 bucket name first')
      return
    }
    quickCreateMutation.mutate(
      { bucket, prefix: formValues.prefix?.trim() || '', region },
      {
        onSuccess: (resp) => {
          const data = resp?.data
          if (!data) {
            toast.error('Quick-create URL response was empty')
            return
          }
          const nextValues = { ...formValues, externalId: data.externalId }
          setFormValues(nextValues)
          saveDraft('s3', { formValues: nextValues, name: connectorName })
          window.open(data.url, '_blank', 'noopener,noreferrer')
          toast.success(
            'Opened AWS Console. Create the stack, then paste the Role ARN below.',
          )
        },
        onError: (err) =>
          toast.error(
            err instanceof Error ? err.message : 'Failed to build quick-create URL',
          ),
      },
    )
  }

  const handleDelete = (connectorId: string, name: string) => {
    deleteMutation.mutate(connectorId, {
      onSuccess: () => toast.success(`Deleted "${name}"`),
      onError: () => toast.error(`Failed to delete "${name}"`),
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Log Connectors</CardTitle>
          <span
            className={cn(
              'text-[11px] font-medium px-2 py-0.5 rounded-full',
              connectors.length > 0
                ? 'bg-brand-500/10 text-brand-400'
                : 'bg-surface-elevated text-text-muted',
            )}
          >
            {connectors.length > 0
              ? `${connectors.length} connector${connectors.length !== 1 ? 's' : ''}`
              : 'Not configured'}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <p className="text-xs text-text-muted">
            Connect your log sources for raw log drill-down. LogWeave reads logs on demand when you
            click into a pattern — no data is stored.
          </p>

          {/* Existing connectors */}
          {connectors.length > 0 && (
            <div className="space-y-2">
              {connectors.map((c) => (
                <div
                  key={c.connectorId}
                  className="flex items-center justify-between rounded-[var(--radius-md)] border border-border-subtle bg-surface-base px-3 py-2"
                >
                  <div>
                    <span className="text-sm text-text-primary font-medium">{c.name}</span>
                    <span className="text-[10px] text-text-muted ml-2">{typeLabel(c.type)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleTest(c.connectorId, c.name)}
                      disabled={testMutation.isPending}
                    >
                      {testMutation.isPending ? 'Testing...' : 'Test'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger-500 hover:text-danger-400"
                      onClick={() => handleDelete(c.connectorId, c.name)}
                      disabled={deleteMutation.isPending}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add connector form */}
          {showAddForm ? (
            <div className="rounded-[var(--radius-md)] border border-border-subtle bg-surface-base p-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Input
                  placeholder="Connector name"
                  value={connectorName}
                  onChange={(e) => setConnectorName(e.target.value)}
                  autoFocus
                />
                <select
                  value={connectorType}
                  onChange={(e) => {
                    setConnectorType(e.target.value as ConnectorType)
                    setFormValues({})
                  }}
                  className="text-xs bg-surface-elevated border border-border-subtle rounded-[var(--radius-md)] px-2 py-1.5 text-text-primary"
                >
                  {TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* S3 quick-create hint */}
              {connectorType === 's3' && !formValues.endpoint?.trim() && (
                <div className="rounded-[var(--radius-md)] border border-border-subtle bg-surface-elevated px-3 py-2 text-[11px] text-text-muted space-y-1.5">
                  {draftActive ? (
                    <>
                      <div className="text-text-primary">
                        ✓ ExternalId generated and stored in this browser.
                      </div>
                      <div>
                        {restoredFromDraft
                          ? 'Picked up from your previous session. '
                          : 'AWS Console opened in a new tab — '}
                        Complete CloudFormation in AWS, then paste the Role ARN
                        below and save.{' '}
                        <button
                          type="button"
                          onClick={handleStartOver}
                          className="text-text-muted underline decoration-dotted hover:text-text-primary"
                        >
                          Start over
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <span className="text-text-primary font-medium">Quick setup:</span>{' '}
                        enter your bucket and region above, click{' '}
                        <em>Quick-create IAM role</em>, then paste the Role ARN AWS shows you
                        back into the form.
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={handleQuickCreate}
                        disabled={quickCreateMutation.isPending}
                      >
                        {quickCreateMutation.isPending
                          ? 'Building URL...'
                          : 'Quick-create IAM role'}
                      </Button>
                    </>
                  )}
                </div>
              )}

              {/* Dynamic fields */}
              <div className="space-y-2">
                {fieldsForType(connectorType).map((field) => {
                  // ExternalId is generated by quick-create, not user-entered.
                  // Editing it would de-sync from the CloudFormation stack the
                  // user just created. Lock it once populated; Start over to clear.
                  const isLockedExternalId =
                    field.key === 'externalId' && !!formValues.externalId?.trim()
                  return (
                    <div key={field.key}>
                      <label className="text-[10px] text-text-muted block mb-0.5">
                        {field.label}
                        {field.required && <span className="text-danger-500 ml-0.5">*</span>}
                      </label>
                      <Input
                        type={field.type ?? 'text'}
                        placeholder={field.placeholder}
                        value={formValues[field.key] ?? ''}
                        onChange={(e) =>
                          setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                        }
                        readOnly={isLockedExternalId}
                      />
                    </div>
                  )
                })}

                {/* Log format selector for S3 and filesystem */}
                {(connectorType === 's3' || connectorType === 'filesystem') && (
                  <div>
                    <label className="text-[10px] text-text-muted block mb-0.5">Log Format</label>
                    <select
                      value={formValues.logFormat ?? (connectorType === 'filesystem' ? 'text' : 'jsonl')}
                      onChange={(e) =>
                        setFormValues((prev) => ({ ...prev, logFormat: e.target.value }))
                      }
                      className="text-xs bg-surface-elevated border border-border-subtle rounded-[var(--radius-md)] px-2 py-1.5 text-text-primary w-full"
                    >
                      <option value="jsonl">JSON Lines</option>
                      <option value="text">Plain Text</option>
                    </select>
                  </div>
                )}

                {/* Compression selector for S3 */}
                {connectorType === 's3' && (
                  <div>
                    <label className="text-[10px] text-text-muted block mb-0.5">Compression</label>
                    <select
                      value={formValues.compression ?? 'none'}
                      onChange={(e) =>
                        setFormValues((prev) => ({ ...prev, compression: e.target.value }))
                      }
                      className="text-xs bg-surface-elevated border border-border-subtle rounded-[var(--radius-md)] px-2 py-1.5 text-text-primary w-full"
                    >
                      <option value="none">None</option>
                      <option value="gzip">Gzip</option>
                    </select>
                  </div>
                )}
              </div>

              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="ghost" onClick={resetForm}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={handleCreate}
                  disabled={createMutation.isPending}
                >
                  {createMutation.isPending ? 'Saving...' : 'Test & Save'}
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" onClick={() => setShowAddForm(true)}>
              Add Connector
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
