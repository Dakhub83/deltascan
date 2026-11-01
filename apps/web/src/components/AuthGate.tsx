import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { LoaderCircle, Radar } from 'lucide-react';
import clsx from 'clsx';
import { fetchSession, signIn, signUp, type SessionInfo } from '../lib/session';
import { useSessionStore } from '../store/sessionStore';

const MIN_PASSWORD = 8;

function Brand() {
  return (
    <a href="/" className="mb-6 flex items-center justify-center gap-2 text-[15px] font-semibold tracking-tight text-fg">
      <span className="grid size-8 place-items-center rounded-lg bg-accent/15 text-accent ring-1 ring-accent/30">
        <Radar className="size-4" />
      </span>
      <span>
        Delta<span className="text-accent">Scan</span>
      </span>
    </a>
  );
}

function SignInForm({ signupOpen, onDone }: { signupOpen: boolean; onDone: () => void }) {
  const [mode, setMode] = useState<'signin' | 'signup'>(signupOpen ? 'signup' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signingUp = mode === 'signup';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (signingUp && password.length < MIN_PASSWORD) return setError(`Use a password of at least ${MIN_PASSWORD} characters.`);
    setBusy(true);
    setError(null);
    try {
      await (signingUp ? signUp : signIn)(email, password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const field = (label: string, input: ReactNode) => (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-dim">{label}</span>
      {input}
    </label>
  );
  const inputClass =
    'h-9 w-full rounded-md border border-line-strong bg-bg px-3 text-[13px] text-fg outline-none transition-colors placeholder:text-muted focus:border-accent/70';

  return (
    <div className="grid h-full place-items-center overflow-auto bg-bg px-4 py-10">
      <div className="w-full max-w-[360px]">
        <Brand />
        <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-panel p-6 shadow-2xl shadow-black/40">
          <div>
            <h1 className="text-[16px] font-semibold text-fg">{signingUp ? 'Create your account' : 'Sign in'}</h1>
            <p className="mt-1 text-[12px] text-muted">
              {signingUp ? 'Your watchlists and layouts are saved to it.' : 'Welcome back. Your layouts and watchlist are waiting.'}
            </p>
          </div>
          {field(
            'Email',
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="you@example.com" autoFocus />,
          )}
          {field(
            'Password',
            <input
              type="password"
              autoComplete={signingUp ? 'new-password' : 'current-password'}
              required
              minLength={signingUp ? MIN_PASSWORD : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
              placeholder={signingUp ? `At least ${MIN_PASSWORD} characters` : ''}
            />,
          )}
          {error && (
            <p role="alert" className="rounded-md bg-down/10 px-3 py-2 text-[12px] text-down ring-1 ring-down/25 ring-inset">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-accent text-[13px] font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-60"
          >
            {busy && <LoaderCircle className="size-4 animate-spin" />}
            {signingUp ? 'Create account' : 'Sign in'}
          </button>
          {signupOpen && (
            <p className="text-center text-[12px] text-muted">
              {signingUp ? 'Already have an account? ' : 'New here? '}
              <button type="button" onClick={() => (setMode(signingUp ? 'signin' : 'signup'), setError(null))} className="font-medium text-accent hover:underline">
                {signingUp ? 'Sign in' : 'Create an account'}
              </button>
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

/**
 * Asks the server who is signed in before the dashboard opens its data connection. With sign-in
 * required and nobody signed in, shows the sign-in form instead.
 */
export function AuthGate({ onReady, children }: { onReady: () => void; children: ReactNode }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setSession = useSessionStore((s) => s.setSession);
  const started = useRef(false);

  const check = () => {
    setError(null);
    fetchSession()
      .then((next) => {
        setInfo(next);
        setSession(next);
      })
      .catch((err: Error) => setError(err.message));
  };
  useEffect(check, []);

  const allowed = !!info && (!info.authRequired || !!info.user);
  useEffect(() => {
    if (allowed && !started.current) {
      started.current = true;
      onReady();
    }
  }, [allowed, onReady]);

  if (error) {
    return (
      <div className="grid h-full place-items-center bg-bg px-4 text-center">
        <div>
          <p className="text-[13px] text-fg">Can't reach the DeltaScan server.</p>
          <p className="mt-1 text-[12px] text-muted">{error}</p>
          <button type="button" onClick={check} className="mt-4 rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-accent/90">
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!info) {
    return (
      <div className={clsx('grid h-full place-items-center bg-bg text-muted')}>
        <LoaderCircle className="size-5 animate-spin" aria-label="Loading" />
      </div>
    );
  }
  if (!allowed) return <SignInForm signupOpen={info.signupOpen} onDone={check} />;
  return <>{children}</>;
}
