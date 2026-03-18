import { useState } from 'react'
import { toast } from 'sonner'
import {
  useDeleteSlackSettings,
  useSaveSlackSettings,
  useSlackSettings,
  useTestSlackConnection,
} from '../../api/queries'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { cn } from '../../lib/cn'

export function SettingsPage() {
  const { data: settingsResponse, isLoading } = useSlackSettings()
  const settings = settingsResponse?.data
  const saveMutation = useSaveSlackSettings()
  const deleteMutation = useDeleteSlackSettings()
  const testMutation = useTestSlackConnection()
  const [webhookUrl, setWebhookUrl] = useState('')

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
    </div>
  )
}
