import { useId, useState } from 'react'
import { toast } from 'sonner'
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '../../api/queries'
import type { ApiKeyEntry } from '../../api/types'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { cn } from '../../lib/cn'
import { formatRelativeTime } from '../../lib/format-time'

/**
 * Settings → API Keys.
 *
 * Service-token semantics (not personal access tokens): keys belong to the
 * tenant, are created by an admin, and outlive any specific user. The raw
 * key is only ever shown once — at creation time, via a modal — and never
 * persisted in this component's state after the modal dismisses.
 */
export function ApiKeysSettings() {
  const { data: keysResponse } = useApiKeys()
  const keys: ApiKeyEntry[] = keysResponse?.data ?? []
  const createMutation = useCreateApiKey()
  const revokeMutation = useRevokeApiKey()

  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [createdKey, setCreatedKey] = useState<{ name: string; key: string } | null>(null)
  const nameId = useId()

  const handleCreate = () => {
    const trimmed = newName.trim()
    if (!trimmed) {
      toast.error('Name is required')
      return
    }
    createMutation.mutate(
      { name: trimmed },
      {
        onSuccess: (resp) => {
          const data = resp?.data
          if (!data) {
            toast.error('Create response was empty')
            return
          }
          setCreatedKey({ name: data.name, key: data.key })
          setNewName('')
          setShowCreate(false)
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to create key'),
      },
    )
  }

  const handleRevoke = (keyId: string, name: string) => {
    if (!confirm(`Revoke "${name}"? Services using this key will stop working immediately.`)) {
      return
    }
    revokeMutation.mutate(keyId, {
      onSuccess: () => toast.success(`Revoked "${name}"`),
      onError: () => toast.error(`Failed to revoke "${name}"`),
    })
  }

  const handleCopy = (key: string) => {
    void navigator.clipboard.writeText(key).then(
      () => toast.success('Copied to clipboard'),
      () => toast.error('Copy failed — select and copy manually'),
    )
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>API Keys</CardTitle>
            <span
              className={cn(
                'text-[11px] font-medium px-2 py-0.5 rounded-full',
                keys.length > 0
                  ? 'bg-brand-500/10 text-brand-400'
                  : 'bg-surface-elevated text-text-muted',
              )}
            >
              {keys.length > 0 ? `${keys.length} key${keys.length !== 1 ? 's' : ''}` : 'No keys'}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <p className="text-xs text-text-muted">
              Service tokens that authenticate SDKs, MCP clients, and direct API callers. Created
              keys are shown <strong>once</strong> at creation time. Revoke any key without a server
              restart.
            </p>

            {keys.length > 0 && (
              <div className="space-y-2">
                {keys.map((k) => (
                  <div
                    key={k.keyId}
                    className="flex items-center justify-between rounded-[var(--radius-md)] border border-border-subtle bg-surface-base px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-sm text-text-primary font-medium truncate">{k.name}</div>
                      <div className="text-[10px] text-text-muted font-mono">
                        {k.prefix}…
                        <span
                          className="ml-2 text-text-muted/70"
                          title={formatRelativeTime(k.createdAt).iso}
                        >
                          created {formatRelativeTime(k.createdAt).relative}
                        </span>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger-500 hover:text-danger-400"
                      onClick={() => handleRevoke(k.keyId, k.name)}
                      disabled={revokeMutation.isPending}
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {showCreate ? (
              <div className="rounded-[var(--radius-md)] border border-border-subtle bg-surface-base p-3 space-y-3">
                <div className="space-y-1">
                  <label htmlFor={nameId} className="text-xs text-text-secondary font-medium block">
                    Key name
                  </label>
                  <p className="text-[10px] text-text-muted">
                    A label so you can identify the key in this list and in audit logs. e.g.{' '}
                    <code>production-ingest</code>.
                  </p>
                  <Input
                    id={nameId}
                    autoFocus
                    placeholder="production-ingest"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setShowCreate(false)
                      setNewName('')
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={handleCreate}
                    disabled={createMutation.isPending}
                  >
                    {createMutation.isPending ? 'Creating…' : 'Create key'}
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" onClick={() => setShowCreate(true)}>
                Create key
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Show-once modal: dismissing this is the only path away from the raw
          key view. We deliberately do NOT dismiss on backdrop-click — an
          accidental outside-click would silently destroy the only copy of a
          freshly-minted secret. The user must press "I've saved it" (or Copy
          first, then dismiss). Likewise no Escape handler. */}
      {createdKey && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div
            className="rounded-[var(--radius-md)] bg-surface-card border border-border-subtle p-4 max-w-md w-full space-y-3"
            role="dialog"
            aria-modal="true"
            aria-labelledby="api-key-modal-title"
          >
            <h3 id="api-key-modal-title" className="text-sm font-medium text-text-primary">
              New API key: <span className="font-mono">{createdKey.name}</span>
            </h3>
            <p className="text-xs text-warning-500">
              This is the only time you'll see this key. Copy it and store it in a secrets manager
              now — there's no recovery if it's lost.
            </p>
            <div className="rounded-[var(--radius-md)] bg-surface-base border border-border-subtle p-2 font-mono text-xs break-all select-all">
              {createdKey.key}
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => handleCopy(createdKey.key)}>
                Copy
              </Button>
              <Button size="sm" variant="primary" onClick={() => setCreatedKey(null)}>
                I've saved it
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
