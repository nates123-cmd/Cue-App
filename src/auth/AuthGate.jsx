import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const STATES = { loading: 'loading', prompt: 'prompt', code: 'code', ready: 'ready' }

export function AuthGate({ children }) {
  const [state, setState] = useState(STATES.loading)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let mounted = true
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return
      setState(data.session ? STATES.ready : STATES.prompt)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!mounted) return
      setState(session ? STATES.ready : STATES.prompt)
    })
    return () => { mounted = false; sub.subscription.unsubscribe() }
  }, [])

  const sendCode = async (e) => {
    e.preventDefault()
    if (!email || sending) return
    setSending(true); setError(null)
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    })
    setSending(false)
    if (error) { setError(error.message); return }
    setCode(''); setState(STATES.code)
  }

  const verifyCode = async (e) => {
    e.preventDefault()
    if (code.length !== 8 || verifying) return
    setVerifying(true); setError(null)
    const { error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' })
    setVerifying(false)
    if (error) { setError(error.message); return }
  }

  if (state === STATES.loading) return <div className="auth-shell" />
  if (state === STATES.ready) return children

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-eyebrow">cue</div>
        <h1 className="auth-title">Sign in</h1>

        {state === STATES.prompt && (
          <form onSubmit={sendCode} className="auth-form">
            <label className="auth-label" htmlFor="auth-email">email</label>
            <input
              id="auth-email" className="auth-input"
              type="email" autoComplete="email" autoFocus
              value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com" required
            />
            <button className="auth-btn" type="submit" disabled={sending || !email}>
              {sending ? 'sending…' : 'email me a code'}
            </button>
            {error && <div className="auth-error">{error}</div>}
          </form>
        )}

        {state === STATES.code && (
          <form onSubmit={verifyCode} className="auth-form">
            <p className="auth-hint">We sent an 8-digit code to <strong>{email}</strong>.</p>
            <label className="auth-label" htmlFor="auth-code">code</label>
            <input
              id="auth-code" className="auth-input"
              type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
              placeholder="12345678" maxLength={8} required
            />
            <button className="auth-btn" type="submit" disabled={verifying || code.length !== 8}>
              {verifying ? 'verifying…' : 'sign in'}
            </button>
            {error && <div className="auth-error">{error}</div>}
            <button type="button" className="auth-btn-link"
              onClick={() => { setError(null); setCode(''); setState(STATES.prompt) }}>
              use a different email
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
