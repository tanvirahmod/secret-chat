import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MessageSquareLock } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuth } from '../contexts/AuthContext'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const { login } = useAuth()
  const navigate = useNavigate()

  async function onSubmit(e) {
    e.preventDefault()
    if (!username.trim() || !password) return
    setSubmitting(true)
    try {
      const p = await login(username.trim(), password)
      toast.success(`Welcome, ${p.display_name || p.username}`)
      navigate(p.role === 'admin' ? '/admin' : '/chat', { replace: true })
    } catch (err) {
      toast.error(err.message || 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center bg-slate-950 p-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-xl bg-indigo-600 flex items-center justify-center">
            <MessageSquareLock className="text-white" size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-white">Secure Chat</h1>
            <p className="text-sm text-slate-400">Sign in with your assigned credentials</p>
          </div>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-slate-300 mb-1">User ID / Username</label>
            <input
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-white outline-none focus:border-indigo-500"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">Password</label>
            <input
              type="password"
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-white outline-none focus:border-indigo-500"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-medium py-2.5 transition"
          >
            {submitting ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
        <p className="text-xs text-slate-500 mt-6">Accounts are created by the Controller. No public registration.</p>
      </div>
    </div>
  )
}


