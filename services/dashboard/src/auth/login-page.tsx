import { useState, type FormEvent } from 'react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { useAuth } from './auth-provider'

export function LoginPage() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const result = await login(username, password, totpCode || undefined)
    if (result.error) {
      setError(result.error)
    }
    setLoading(false)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-base p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="h-12 w-12 rounded-[var(--radius-lg)] bg-brand-500 flex items-center justify-center text-white font-bold text-lg mx-auto mb-3">
            LW
          </div>
          <h1 className="text-lg font-semibold text-text-primary">LogWeave</h1>
          <p className="text-xs text-text-muted mt-1">Sign in to your dashboard</p>
        </div>

        {/* Login form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="username" className="block text-xs font-medium text-text-secondary mb-1">
              Username
            </label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              autoComplete="username"
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-xs font-medium text-text-secondary mb-1">
              Password
            </label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              autoComplete="current-password"
            />
          </div>

          <div>
            <label htmlFor="totpCode" className="block text-xs font-medium text-text-secondary mb-1">
              2FA Code <span className="text-text-muted">(if enabled)</span>
            </label>
            <Input
              id="totpCode"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              placeholder="6-digit code"
              maxLength={6}
              autoComplete="one-time-code"
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
            disabled={loading || !username || !password}
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </Button>
        </form>

        <p className="text-[10px] text-text-disabled text-center mt-6">
          Your admin provides login credentials. This is the same key used for SDK and MCP.
        </p>
      </div>
    </div>
  )
}
