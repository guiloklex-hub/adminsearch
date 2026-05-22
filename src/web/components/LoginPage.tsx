import { useState } from 'react';
import { ApiError, api } from '@web/lib/api.ts';

export function LoginPage({
  setupRequired,
  onAuthenticated,
}: {
  setupRequired: boolean;
  onAuthenticated: () => void;
}) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const path = setupRequired ? '/api/v1/auth/setup' : '/api/v1/auth/login';
      await api(path, { method: 'POST', json: { username, password } });
      onAuthenticated();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Erro inesperado');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        background: 'var(--color-bg)',
      }}
    >
      <form
        onSubmit={submit}
        style={{
          background: 'var(--color-surface)',
          padding: 32,
          borderRadius: 12,
          width: 360,
          border: '1px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ fontSize: 22, fontWeight: 700 }}>adminsearch</div>
        <div style={{ color: 'var(--color-muted)', fontSize: 13, marginBottom: 12 }}>
          {setupRequired
            ? 'Crie a conta de administrador local (este passo só roda uma vez).'
            : 'Acesse com sua conta de administrador local.'}
        </div>

        <label style={{ fontSize: 12, color: 'var(--color-muted)' }}>Usuário</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          minLength={1}
          maxLength={64}
          style={inputStyle}
        />

        <label style={{ fontSize: 12, color: 'var(--color-muted)' }}>Senha</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={setupRequired ? 12 : 8}
          maxLength={256}
          style={inputStyle}
        />

        {error && (
          <div style={{ color: 'var(--color-critical)', fontSize: 13 }}>{error}</div>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            marginTop: 12,
            padding: '10px 14px',
            background: 'var(--color-accent)',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            fontWeight: 600,
          }}
        >
          {loading ? 'Aguarde...' : setupRequired ? 'Criar admin' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  color: 'var(--color-text)',
  fontSize: 14,
};
