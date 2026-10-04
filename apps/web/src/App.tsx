import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell.js';
import { useAuth } from './lib/auth.js';
import { BackupPage } from './pages/Backup.js';
import { HomePage } from './pages/Home.js';
import { LoginPage } from './pages/Login.js';
import { Placeholder } from './pages/Placeholder.js';
import { SettingsPage } from './pages/Settings.js';
import { ChangePasswordPage, UserFormPage, UsersPage } from './pages/Users.js';

export function App() {
  const { me, loading } = useAuth();
  if (loading) return <div className="login"><p className="muted">در حال بارگذاری…</p></div>;
  if (!me) return <LoginPage />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<HomePage />} />
        <Route path="products" element={<Placeholder title="محصولات" phase="فاز ۱" />} />
        <Route path="orders" element={<Placeholder title="سفارش‌ها" phase="فاز ۱" />} />
        <Route path="accounts" element={<Placeholder title="حساب‌ها" phase="فاز ۳" />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="settings/users" element={<UsersPage />} />
        <Route path="settings/users/:id" element={<UserFormPage />} />
        <Route path="settings/backup" element={<BackupPage />} />
        <Route path="settings/password" element={<ChangePasswordPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
