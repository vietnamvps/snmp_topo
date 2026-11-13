import { useEffect, useState, type FormEvent } from 'react';

type Account = { id: number; username: string; role: 'admin' | 'viewer' };
type ListedAccount = Account & { disabled: number };

export async function accountRequest(path: string, method = 'GET', body?: unknown) {
  return fetch('/api/' + path, {
    method,
    ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}) }),
  });
}

function PasswordInput({ name, label, autoComplete }: { name: string; label: string; autoComplete: string }) {
  const [visible, setVisible] = useState(false);
  return <label>{label}<span className="account-password">
    <input name={name} type={visible ? 'text' : 'password'} autoComplete={autoComplete} minLength={12} maxLength={256} required />
    <button type="button" className="config-button" aria-pressed={visible} onClick={() => setVisible(!visible)}>
      {visible ? 'Ẩn' : 'Hiện'}
    </button>
  </span></label>;
}

export function LoginPage() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const response = await accountRequest('auth/login', 'POST', {
        username: fields.get('username'), password: fields.get('password'), remember: fields.has('remember'),
      });
      if (response.ok) { location.replace('/'); return; }
      setError(response.status === 429 ? 'Vui lòng thử lại sau một phút.' : 'Sai tài khoản hoặc mật khẩu');
    } catch { setError('Không kết nối được với máy chủ.'); }
    finally { setBusy(false); }
  }
  return <main className="account-screen" lang="vi">
    <form className="account-panel" onSubmit={submit}>
      <h1>Đăng nhập OPNsense NOC</h1>
      <label>Tên tài khoản<input name="username" autoComplete="username" maxLength={64} required autoFocus /></label>
      <PasswordInput name="password" label="Mật khẩu" autoComplete="current-password" />
      <label className="account-remember"><input name="remember" type="checkbox" /> Ghi nhớ đăng nhập</label>
      {error && <p role="alert" className="config-error">{error}</p>}
      <button className="config-button config-save" disabled={busy}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>
    </form>
  </main>;
}

export function AccountMenu() {
  const [user, setUser] = useState<Account>();
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void accountRequest('auth/me').then(async response => {
      if (response.ok) {
        const account = await response.json();
        if (active) setUser(account);
      }
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  if (!user) return <a className="config-button" href="/login">Đăng nhập</a>;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    try {
      const result = await accountRequest('auth/change-password', 'POST', {
        currentPassword: fields.get('currentPassword'), password: fields.get('password'),
      });
      if (!result.ok) { setError('Không đổi được mật khẩu. Kiểm tra mật khẩu hiện tại.'); return; }
      location.replace('/login');
    } catch { setError('Không kết nối được với máy chủ.'); }
  }

  return <details className="account-menu" lang="vi">
    <summary>{user.username}</summary>
    <div className="account-panel">
      <p>{user.role === 'admin' ? 'Quản trị viên' : 'Người xem'}</p>
      {user.role === 'admin' && <a className="config-button" href="/users">Quản lý tài khoản</a>}
      <button className="config-button" onClick={() => setChanging(!changing)}>Đổi mật khẩu</button>
      {changing && <form onSubmit={submit} className="account-form">
        <PasswordInput name="currentPassword" label="Mật khẩu hiện tại" autoComplete="current-password" />
        <PasswordInput name="password" label="Mật khẩu mới" autoComplete="new-password" />
        <button className="config-button">Lưu mật khẩu</button>
      </form>}
      <button className="config-button" onClick={async () => {
        try {
          if ((await accountRequest('auth/logout', 'POST')).ok) { location.replace('/login'); return; }
        } catch { /* Show the same error on network and HTTP failure. */ }
        setError('Không đăng xuất được.');
      }}>Đăng xuất</button>
      {error && <p role="alert" className="config-error">{error}</p>}
    </div>
  </details>;
}

export function UsersPage() {
  const [users, setUsers] = useState<ListedAccount[]>([]);
  const [error, setError] = useState('');
  const [allowed, setAllowed] = useState(false);
  async function refresh() {
    try {
      const response = await accountRequest('users');
      setAllowed(response.ok);
      if (response.ok) setUsers(await response.json());
      else setError('Cần quyền quản trị viên.');
    } catch { setError('Không tải được danh sách tài khoản.'); }
  }
  useEffect(() => { void refresh(); }, []);
  async function change(path: string, method: string, body?: unknown) {
    setError('');
    try {
      const response = await accountRequest(path, method, body);
      if (!response.ok) {
        setError(response.status === 409 ? 'Thao tác xung đột với tài khoản hiện tại.' : 'Không lưu được thay đổi.');
        return false;
      }
      await refresh();
      return true;
    } catch { setError('Không kết nối được với máy chủ.'); return false; }
  }
  return <main className="account-screen" lang="vi">
    <section className="account-panel account-users">
      <a href="/">Về sơ đồ mạng</a>
      <h1>Quản lý tài khoản</h1>
      {error && <p role="alert" className="config-error">{error}</p>}
      {allowed && <>
        <form className="account-form" onSubmit={async event => {
          event.preventDefault();
          const form = event.currentTarget;
          const fields = new FormData(form);
          if (await change('users', 'POST', Object.fromEntries(fields))) form.reset();
        }}>
          <label>Tên tài khoản<input name="username" maxLength={64} required /></label>
          <PasswordInput name="password" label="Mật khẩu (ít nhất 12 ký tự)" autoComplete="new-password" />
          <label>Vai trò<select name="role"><option value="viewer">Người xem</option><option value="admin">Quản trị viên</option></select></label>
          <button className="config-button">Thêm tài khoản</button>
        </form>
        <ul>{users.map(user => <li key={user.id}>
          <strong>{user.username}</strong>
          <select aria-label={'Vai trò của ' + user.username} value={user.role}
            onChange={event => void change('users/' + user.id, 'PATCH', { role: event.target.value })}>
            <option value="viewer">Người xem</option><option value="admin">Quản trị viên</option>
          </select>
          <button className="config-button" onClick={() => void change('users/' + user.id, 'PATCH', { disabled: !user.disabled })}>
            {user.disabled ? 'Bật lại' : 'Vô hiệu hóa'}
          </button>
          <button className="config-button danger" onClick={() => {
            if (confirm('Xóa tài khoản ' + user.username + '?')) void change('users/' + user.id, 'DELETE');
          }}>Xóa</button>
        </li>)}</ul>
      </>}
    </section>
  </main>;
}
