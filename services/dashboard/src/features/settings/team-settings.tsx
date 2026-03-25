import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useAuth } from '../../auth/auth-provider'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { api } from '../../lib/api-client'

interface TeamUser {
  userId: string
  username: string
  tenantId: string
  role: 'admin' | 'viewer'
  totpEnabled: boolean
  lastLoginAt: string | null
}

interface ApiResponse<T> {
  data: T
}

export function TeamSettings() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [showAddForm, setShowAddForm] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState<'viewer' | 'admin'>('viewer')

  const { data: usersResponse } = useQuery({
    queryKey: ['auth', 'users'],
    queryFn: () => api.get<ApiResponse<TeamUser[]>>('/v1/auth/users'),
    enabled: user?.role === 'admin',
  })

  const users = usersResponse?.data ?? []

  const createMutation = useMutation({
    mutationFn: (input: { username: string; password: string; tenantId: string; role: 'admin' | 'viewer' }) =>
      api.post('/v1/auth/users', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['auth', 'users'] })
      toast.success(`User "${newUsername}" created`)
      setNewUsername('')
      setNewPassword('')
      setShowAddForm(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to create user'),
  })

  const deleteMutation = useMutation({
    mutationFn: (userId: string) => api.del(`/v1/auth/users/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['auth', 'users'] })
      toast.success('User removed')
    },
    onError: () => toast.error('Failed to remove user'),
  })

  const resetPasswordMutation = useMutation({
    mutationFn: ({ userId, newPassword }: { userId: string; newPassword: string }) =>
      api.put(`/v1/auth/users/${userId}/password`, { newPassword }),
    onSuccess: () => toast.success('Password reset — user will be prompted to change it'),
    onError: () => toast.error('Failed to reset password'),
  })

  if (user?.role !== 'admin') return null

  const handleCreate = () => {
    if (!newUsername || !newPassword) return
    if (newPassword.length < 12) {
      toast.error('Password must be at least 12 characters')
      return
    }
    createMutation.mutate({
      username: newUsername,
      password: newPassword,
      tenantId: user.tenantId,
      role: newRole,
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Team</CardTitle>
          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-400">
            {users.length} user{users.length !== 1 ? 's' : ''}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <p className="text-xs text-text-muted">
            Manage who can access the LogWeave dashboard. All users share the same tenant data.
          </p>

          {/* User list */}
          <div className="space-y-2">
            {users.map((u) => (
              <div
                key={u.userId}
                className="flex items-center justify-between rounded-[var(--radius-md)] border border-border-subtle bg-surface-base px-3 py-2"
              >
                <div className="flex items-center gap-3">
                  <div>
                    <span className="text-sm text-text-primary font-medium">{u.username}</span>
                    <span className="text-[10px] text-text-muted ml-2">{u.role}</span>
                  </div>
                  {u.totpEnabled && (
                    <span className="text-[10px] bg-success-500/10 text-success-500 px-1.5 py-0.5 rounded-full">
                      2FA
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {u.lastLoginAt && (
                    <span className="text-[10px] text-text-muted">
                      Last login: {new Date(u.lastLoginAt).toLocaleDateString()}
                    </span>
                  )}
                  {u.userId !== user.userId && (
                    <>
                      <ResetPasswordButton userId={u.userId} username={u.username} onReset={resetPasswordMutation.mutate} />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger-500 hover:text-danger-400"
                        onClick={() => deleteMutation.mutate(u.userId)}
                        disabled={deleteMutation.isPending}
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Add user form */}
          {showAddForm ? (
            <div className="rounded-[var(--radius-md)] border border-border-subtle bg-surface-base p-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Input
                  placeholder="Username"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  autoFocus
                />
                <Input
                  type="password"
                  placeholder="Password (min 12 chars)"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as 'viewer' | 'admin')}
                  className="text-xs bg-surface-elevated border border-border-subtle rounded-[var(--radius-md)] px-2 py-1.5 text-text-primary"
                >
                  <option value="viewer">Viewer</option>
                  <option value="admin">Admin</option>
                </select>
                <div className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => setShowAddForm(false)}>Cancel</Button>
                <Button size="sm" variant="primary" onClick={handleCreate} disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Creating...' : 'Create User'}
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" onClick={() => setShowAddForm(true)}>
              Add User
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function ResetPasswordButton({ userId, onReset }: { userId: string; username: string; onReset: (args: { userId: string; newPassword: string }) => void }) {
  const [show, setShow] = useState(false)
  const [newPassword, setNewPassword] = useState('')

  if (!show) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setShow(true)}>
        Reset Password
      </Button>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <Input
        type="password"
        placeholder="New password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        className="w-32 h-7 text-xs"
        autoFocus
      />
      <Button
        size="sm"
        variant="primary"
        onClick={() => {
          if (newPassword.length < 12) {
            toast.error('Password must be at least 12 characters')
            return
          }
          onReset({ userId, newPassword })
          setShow(false)
          setNewPassword('')
        }}
      >
        Set
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setShow(false)}>
        Cancel
      </Button>
    </div>
  )
}
