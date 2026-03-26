import { useState } from 'react'
import { toast } from 'sonner'
import {
  useDeleteSlackSettings,
  useSaveSlackSettings,
  useSaveTagSettings,
  useSlackSettings,
  useTagSettings,
  useTestSlackConnection,
} from '../../api/queries'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { cn } from '../../lib/cn'
import { ClusteringSettings } from './clustering-settings'
import { ConnectorSettings } from './connector-settings'
import { TeamSettings } from './team-settings'

const TAG_KEY_PATTERN = /^[a-zA-Z0-9_.-]+$/

export function SettingsPage() {
  const { data: settingsResponse, isLoading } = useSlackSettings()
  const settings = settingsResponse?.data
  const saveMutation = useSaveSlackSettings()
  const deleteMutation = useDeleteSlackSettings()
  const testMutation = useTestSlackConnection()
  const [webhookUrl, setWebhookUrl] = useState('')

  const { data: tagResponse } = useTagSettings()
  const tagSettings = tagResponse?.data
  const saveTagsMutation = useSaveTagSettings()
  const [newTagKey, setNewTagKey] = useState('')

  const handleSave = () => {
    if (!webhookUrl.startsWith('https://hooks.slack.com/')) {
      toast.error('Webhook URL must start with https://hooks.slack.com/')
      return
    }
    saveMutation.mutate(webhookUrl, {
      onSuccess: () => {
        toast.success('Slack webhook saved')
        setWebhookUrl('')
      },
      onError: () => toast.error('Failed to save webhook'),
    })
  }

  const handleTest = () => {
    testMutation.mutate(undefined, {
      onSuccess: (result) => {
        const data = result?.data
        if (data?.success) {
          toast.success('Test message sent to Slack!')
        } else {
          toast.error(`Slack test failed: ${data?.error ?? 'unknown error'}`)
        }
      },
      onError: () => toast.error('Failed to test connection'),
    })
  }

  const handleDisconnect = () => {
    deleteMutation.mutate(undefined, {
      onSuccess: () => toast.success('Slack disconnected'),
      onError: () => toast.error('Failed to disconnect'),
    })
  }

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-2xl">
        <h2 className="text-lg font-semibold text-text-primary">Settings</h2>
        <Card>
          <CardContent>
            <p className="text-sm text-text-muted">Loading...</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <h2 className="text-lg font-semibold text-text-primary">Settings</h2>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Slack Integration</CardTitle>
            {settings && (
              <span
                className={cn(
                  'text-[11px] font-medium px-2 py-0.5 rounded-full',
                  settings.configured
                    ? settings.lastTestStatus === 'success'
                      ? 'bg-success/10 text-success'
                      : settings.lastTestStatus === 'failed'
                        ? 'bg-danger/10 text-danger'
                        : 'bg-brand-500/10 text-brand-400'
                    : 'bg-surface-elevated text-text-muted',
                )}
              >
                {settings.configured
                  ? settings.lastTestStatus === 'success'
                    ? 'Connected'
                    : settings.lastTestStatus === 'failed'
                      ? 'Failed'
                      : 'Configured'
                  : 'Not configured'}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <p className="text-xs text-text-muted">
              Get notified in Slack when watched patterns spike. Create a Slack App, enable Incoming
              Webhooks, add to channel, then paste the URL here.
            </p>

            {settings?.configured ? (
              <div className="space-y-3">
                <p className="text-xs text-text-secondary">
                  Webhook configured.
                  {settings.lastTestAt &&
                    ` Last tested: ${new Date(settings.lastTestAt).toLocaleString()}`}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleTest} disabled={testMutation.isPending}>
                    {testMutation.isPending ? 'Testing...' : 'Test Connection'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleDisconnect}
                    disabled={deleteMutation.isPending}
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <Input
                  placeholder="https://hooks.slack.com/services/T.../B.../..."
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                />
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={saveMutation.isPending || !webhookUrl}
                >
                  {saveMutation.isPending ? 'Saving...' : 'Save Webhook'}
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <ClusteringSettings />

      <ConnectorSettings />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Tag Extraction</CardTitle>
            <span
              className={cn(
                'text-[11px] font-medium px-2 py-0.5 rounded-full',
                tagSettings?.extractTags?.length
                  ? 'bg-brand-500/10 text-brand-400'
                  : 'bg-surface-elevated text-text-muted',
              )}
            >
              {tagSettings?.extractTags?.length
                ? `${tagSettings.extractTags.length} key${tagSettings.extractTags.length > 1 ? 's' : ''}`
                : 'Not configured'}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <p className="text-xs text-text-muted">
              Extract custom metadata fields from your log events for searchable tags. Specify which
              field names to extract (e.g. customer_id, order_id, request_id). Max 20 keys.
            </p>

            {tagSettings?.extractTags && tagSettings.extractTags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {tagSettings.extractTags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-surface-elevated text-text-secondary"
                  >
                    {tag}
                    <button
                      type="button"
                      className="text-text-muted hover:text-danger ml-0.5"
                      onClick={() => {
                        const updated = tagSettings.extractTags.filter((t) => t !== tag)
                        saveTagsMutation.mutate(updated, {
                          onSuccess: () => toast.success(`Removed "${tag}"`),
                          onError: () => toast.error('Failed to update tags'),
                        })
                      }}
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <Input
                placeholder="field_name"
                value={newTagKey}
                onChange={(e) => setNewTagKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleAddTag()
                  }
                }}
                className="max-w-[200px]"
              />
              <Button
                size="sm"
                onClick={handleAddTag}
                disabled={saveTagsMutation.isPending || !newTagKey}
              >
                {saveTagsMutation.isPending ? 'Saving...' : 'Add Key'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <TeamSettings />
    </div>
  )

  function handleAddTag() {
    const key = newTagKey.trim()
    if (!key) return
    if (!TAG_KEY_PATTERN.test(key)) {
      toast.error('Tag keys must be alphanumeric with _ . - only')
      return
    }
    if (key.length > 64) {
      toast.error('Tag key must be 64 characters or less')
      return
    }
    const current = tagSettings?.extractTags ?? []
    if (current.includes(key)) {
      toast.error(`"${key}" is already configured`)
      return
    }
    if (current.length >= 20) {
      toast.error('Maximum 20 tag keys')
      return
    }
    saveTagsMutation.mutate([...current, key], {
      onSuccess: () => {
        toast.success(`Added "${key}"`)
        setNewTagKey('')
      },
      onError: () => toast.error('Failed to save tag key'),
    })
  }
}
