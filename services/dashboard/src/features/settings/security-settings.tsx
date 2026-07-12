import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useAuth } from '../../auth/auth-provider'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { csrfHeader } from '../../lib/api-client'
import { cn } from '../../lib/cn'

/**
 * Account security card — the entry point for enabling/disabling TOTP 2FA.
 * Enabling hands off to the full-screen enrollment wizard (`/settings/two-factor`);
 * disabling is done inline since it only needs a password confirmation.
 */
export function SecuritySettings() {
  const { user, refreshUser } = useAuth()
  const navigate = useNavigate()
  const [showDisable, setShowDisable] = useState(false)
  const [password, setPassword] = useState('')
  const [disabling, setDisabling] = useState(false)

  if (!user) return null
  const enabled = user.totpEnabled

  const cancelDisable = () => {
    setShowDisable(false)
    setPassword('')
  }

  const handleDisable = async () => {
    if (!password) return
    setDisabling(true)
    try {
      const res = await fetch('/v1/auth/totp', {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ password }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        toast.success('Two-factor authentication disabled')
        cancelDisable()
        await refreshUser()
      } else {
        toast.error(body.error?.message ?? 'Failed to disable two-factor authentication')
      }
    } catch {
      toast.error('Network error')
    }
    setDisabling(false)
  }

  return (
    <Card id="security">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Two-Factor Authentication</CardTitle>
          <span
            className={cn(
              'text-[11px] font-medium px-2 py-0.5 rounded-full',
              enabled
                ? 'bg-success-500/10 text-success-500'
                : 'bg-surface-elevated text-text-muted',
            )}
          >
            {enabled ? 'Enabled' : 'Not enabled'}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <p className="text-xs text-text-muted">
            Add a second step at sign-in using an authenticator app (Google Authenticator, Authy,
            1Password).{' '}
            {enabled
              ? 'Your account is protected — you enter a 6-digit code after your password.'
              : 'Strongly recommended, especially for admin accounts.'}
          </p>

          {enabled ? (
            showDisable ? (
              <div className="rounded-[var(--radius-md)] border border-border-subtle bg-surface-base p-3 space-y-3">
                <p className="text-xs text-text-secondary">
                  Enter your password to turn off two-factor authentication.
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    placeholder="Current password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="max-w-[220px]"
                    autoFocus
                  />
                  <div className="flex-1" />
                  <Button size="sm" variant="ghost" onClick={cancelDisable}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={handleDisable}
                    disabled={disabling || !password}
                  >
                    {disabling ? 'Disabling...' : 'Disable 2FA'}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="text-danger-500 hover:text-danger-400"
                onClick={() => setShowDisable(true)}
              >
                Disable Two-Factor Authentication
              </Button>
            )
          ) : (
            <Button size="sm" variant="primary" onClick={() => navigate('/settings/two-factor')}>
              Enable Two-Factor Authentication
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
