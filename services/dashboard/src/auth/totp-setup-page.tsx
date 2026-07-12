import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { csrfHeader } from '../lib/api-client'
import { useAuth } from './auth-provider'

export function TotpSetupPage() {
  const { user, refreshUser } = useAuth()
  const navigate = useNavigate()
  const [step, setStep] = useState<'intro' | 'scan' | 'verify' | 'recovery'>('intro')
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [code, setCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const startSetup = async () => {
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/v1/auth/totp/setup', {
        method: 'POST',
        credentials: 'include',
        headers: { ...csrfHeader() },
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        setQrCodeDataUrl(body.data.qrCodeDataUrl)
        setSecretKey(body.data.secret)
        setStep('scan')
      } else {
        setError(body.error?.message ?? 'Failed to start TOTP setup')
      }
    } catch {
      setError('Network error')
    }
    setLoading(false)
  }

  const confirmCode = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/v1/auth/totp/confirm', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ code }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        setRecoveryCodes(body.data.recoveryCodes)
        setStep('recovery')
      } else {
        setError(body.error?.message ?? 'Invalid code')
      }
    } catch {
      setError('Network error')
    }
    setLoading(false)
  }

  const finish = async () => {
    toast.success('Two-factor authentication enabled')
    await refreshUser()
    navigate('/settings')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-base p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="h-12 w-12 rounded-[var(--radius-lg)] bg-brand-500 flex items-center justify-center text-white font-bold text-lg mx-auto mb-3">
            LW
          </div>
          <h1 className="text-lg font-semibold text-text-primary">
            Set Up Two-Factor Authentication
          </h1>
          <p className="text-xs text-text-muted mt-1">
            Secure your account with an authenticator app
          </p>
        </div>

        {step === 'intro' &&
          (user?.totpEnabled ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-text-secondary">
                Two-factor authentication is already enabled on your account. Manage it from
                Settings.
              </p>
              <Button variant="secondary" size="lg" onClick={() => navigate('/settings')}>
                Back to Settings
              </Button>
            </div>
          ) : (
            <div className="space-y-4 text-center">
              <p className="text-sm text-text-secondary">
                You'll need an authenticator app like Google Authenticator, Authy, or 1Password.
              </p>
              {error && (
                <div className="rounded-[var(--radius-md)] bg-danger-500/10 border border-danger-500/30 px-3 py-2">
                  <p className="text-xs text-danger-500">{error}</p>
                </div>
              )}
              <div className="flex items-center justify-center gap-2">
                <Button variant="ghost" size="lg" onClick={() => navigate('/settings')}>
                  Cancel
                </Button>
                <Button variant="primary" size="lg" onClick={startSetup} disabled={loading}>
                  {loading ? 'Setting up...' : 'Get Started'}
                </Button>
              </div>
            </div>
          ))}

        {step === 'scan' && (
          <div className="space-y-4">
            <p className="text-sm text-text-secondary text-center">
              Scan this QR code with your authenticator app:
            </p>
            {qrCodeDataUrl && (
              <div className="flex justify-center">
                <img
                  src={qrCodeDataUrl}
                  alt="TOTP QR Code"
                  className="w-48 h-48 rounded-[var(--radius-md)]"
                />
              </div>
            )}
            <div className="text-center">
              <p className="text-[10px] text-text-muted mb-1">
                Can't scan? Enter this key manually:
              </p>
              <code className="text-xs text-brand-400 bg-surface-elevated px-2 py-1 rounded break-all select-all">
                {secretKey}
              </code>
            </div>
            <form onSubmit={confirmCode} className="space-y-3">
              <div>
                <label
                  htmlFor="totpCode"
                  className="block text-xs font-medium text-text-secondary mb-1"
                >
                  Enter the 6-digit code from your app
                </label>
                <Input
                  id="totpCode"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="000000"
                  maxLength={6}
                  autoComplete="one-time-code"
                  className="text-center text-lg tracking-widest"
                  autoFocus
                />
              </div>
              {error && (
                <div className="rounded-[var(--radius-md)] bg-danger-500/10 border border-danger-500/30 px-3 py-2">
                  <p className="text-xs text-danger-500">{error}</p>
                </div>
              )}
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                disabled={loading || code.length !== 6}
              >
                {loading ? 'Verifying...' : 'Verify'}
              </Button>
            </form>
          </div>
        )}

        {step === 'recovery' && (
          <div className="space-y-4">
            <div className="rounded-[var(--radius-md)] border border-warning-500/30 bg-warning-500/5 p-4">
              <p className="text-sm font-medium text-text-primary mb-2">Save your recovery codes</p>
              <p className="text-xs text-text-muted mb-3">
                If you lose access to your authenticator app, use one of these codes to sign in.
                Each code can only be used once. Store them somewhere safe.
              </p>
              <div className="grid grid-cols-2 gap-1">
                {recoveryCodes.map((code) => (
                  <code
                    key={code}
                    className="text-xs font-mono text-text-secondary bg-surface-base px-2 py-1 rounded text-center"
                  >
                    {code}
                  </code>
                ))}
              </div>
            </div>
            <Button variant="primary" size="lg" className="w-full" onClick={finish}>
              I've saved my recovery codes
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
