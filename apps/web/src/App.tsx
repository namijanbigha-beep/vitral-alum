import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell.js';
import { useAuth } from './lib/auth.js';
import { BackupPage } from './pages/Backup.js';
import { BundleDetail, BundleForm, BundlesPage } from './pages/Bundles.js';
import { ContractForm, ContractsPage, DieDetail, DieForm, DiesPage, LocationForm, LocationsPage, PartiesPage, PartyDetail, PartyForm, ProductDetail, ProductForm, ProductsPage } from './pages/Catalog.js';
import { DieOrderDetail, DieOrderForm, DieOrdersPage } from './pages/DieOrders.js';
import { HelpPage } from './pages/Help.js';
import { DailyReportPage, GalleryPage, NoteDetail, NoteForm, NotesPage, NotificationsPage, SearchPage, TaskDetail, TaskForm, TasksPage } from './pages/Daily.js';
import { HomePage } from './pages/Home.js';
import { LoginPage } from './pages/Login.js';
import { PackingPage, ScaleForm, ScalePage, TransferDetail, TransferForm, TransfersPage } from './pages/Logistics.js';
import { AccountForm, AccountsPage, DocumentDetail, DocumentForm, DocumentsPage, FxForm, FxPage } from './pages/Money.js';
import { OrderDetail, OrderForm, OrdersPage } from './pages/Orders.js';
import { CoatingDetail, CoatingForm, CoatingPage, RunDetail, RunForm, RunsPage } from './pages/Production.js';
import { CorrectionsPage, ShareLinksPage, TelegramPage } from './pages/Profile.js';
import { PublicSharePage } from './pages/Public.js';
import { CostingPage, ImportPage, ReportsPage } from './pages/Reports.js';
import { SettingsPage } from './pages/Settings.js';
import { AdjustPage, LotDetail, LotForm, MaterialsPage, OpeningPage, PurchaseDetail, PurchaseForm, ScrapSalePage, SmeltingPage, StockPage } from './pages/Stock.js';
import { UpdatePage } from './pages/Update.js';
import { ChangePasswordPage, UserFormPage, UsersPage } from './pages/Users.js';

/** Route table. Guest share pages (/s/:token) render before the login gate; everything else needs a session. */
export function App() {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loc.pathname.startsWith('/s/')) return <Routes><Route path="/s/:token" element={<PublicSharePage />} /></Routes>;
  if (loading) return <div className="login"><p className="muted">در حال بارگذاری…</p></div>;
  if (!me) return <LoginPage />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<HomePage />} />
        {/* catalog */}
        <Route path="products" element={<ProductsPage />} /><Route path="products/new" element={<ProductForm />} /><Route path="products/:id" element={<ProductDetail />} /><Route path="products/:id/edit" element={<ProductForm />} />
        <Route path="dies" element={<DiesPage />} /><Route path="dies/new" element={<DieForm />} /><Route path="dies/:id" element={<DieDetail />} /><Route path="dies/:id/edit" element={<DieForm />} />
        <Route path="die-orders" element={<DieOrdersPage />} /><Route path="die-orders/new" element={<DieOrderForm />} /><Route path="die-orders/:id" element={<DieOrderDetail />} /><Route path="die-orders/:id/edit" element={<DieOrderForm />} />
        <Route path="parties" element={<PartiesPage />} /><Route path="parties/new" element={<PartyForm />} /><Route path="parties/:id" element={<PartyDetail />} /><Route path="parties/:id/edit" element={<PartyForm />} />
        <Route path="contracts" element={<ContractsPage />} /><Route path="contracts/new" element={<ContractForm />} /><Route path="contracts/:id" element={<ContractForm />} />
        <Route path="locations" element={<LocationsPage />} /><Route path="locations/new" element={<LocationForm />} /><Route path="locations/:id" element={<LocationForm />} />
        {/* floor */}
        <Route path="bundles" element={<BundlesPage />} /><Route path="bundles/new" element={<BundleForm />} /><Route path="bundles/:id" element={<BundleDetail />} />
        <Route path="production" element={<RunsPage />} /><Route path="production/new" element={<RunForm />} /><Route path="production/:id" element={<RunDetail />} /><Route path="production/:id/edit" element={<RunForm />} />
        <Route path="coating" element={<CoatingPage />} /><Route path="coating/new" element={<CoatingForm />} /><Route path="coating/:id" element={<CoatingDetail />} />
        {/* sales & logistics */}
        <Route path="orders" element={<OrdersPage />} /><Route path="orders/new" element={<OrderForm />} /><Route path="orders/:id" element={<OrderDetail />} /><Route path="orders/:id/edit" element={<OrderForm />} /><Route path="orders/:id/costing" element={<CostingPage />} />
        <Route path="transfers" element={<TransfersPage />} /><Route path="transfers/new" element={<TransferForm />} /><Route path="transfers/:id" element={<TransferDetail />} /><Route path="transfers/:id/edit" element={<TransferForm />} /><Route path="transfers/:id/packing" element={<PackingPage />} />
        <Route path="scale" element={<ScalePage />} /><Route path="scale/new" element={<ScaleForm />} /><Route path="scale/:id" element={<ScaleForm />} />
        {/* stock */}
        <Route path="stock" element={<StockPage />} /><Route path="stock/opening" element={<OpeningPage />} /><Route path="stock/adjust" element={<AdjustPage />} />
        <Route path="materials" element={<MaterialsPage />} /><Route path="materials/lots/new" element={<LotForm />} /><Route path="materials/lots/:id" element={<LotDetail />} /><Route path="materials/lots/:id/edit" element={<LotForm />} />
        <Route path="materials/purchases/new" element={<PurchaseForm />} /><Route path="materials/purchases/:id" element={<PurchaseDetail />} /><Route path="materials/scrap-sale" element={<ScrapSalePage />} /><Route path="materials/smelting" element={<SmeltingPage />} />
        {/* money */}
        <Route path="documents" element={<DocumentsPage />} /><Route path="documents/new" element={<DocumentForm />} /><Route path="documents/:id" element={<DocumentDetail />} />
        <Route path="accounts" element={<AccountsPage />} /><Route path="accounts/new" element={<AccountForm />} /><Route path="accounts/:id" element={<AccountForm />} />
        <Route path="fx-rates" element={<FxPage />} /><Route path="fx-rates/new" element={<FxForm />} />
        {/* daily */}
        <Route path="notes" element={<NotesPage />} /><Route path="notes/new" element={<NoteForm />} /><Route path="notes/:id" element={<NoteDetail />} />
        <Route path="tasks" element={<TasksPage />} /><Route path="tasks/new" element={<TaskForm />} /><Route path="tasks/:id" element={<TaskDetail />} /><Route path="tasks/:id/edit" element={<TaskForm />} />
        <Route path="notifications" element={<NotificationsPage />} /><Route path="gallery" element={<GalleryPage />} /><Route path="search" element={<SearchPage />} />
        {/* reports */}
        <Route path="reports" element={<Navigate to="/reports/daily" replace />} /><Route path="reports/daily" element={<DailyReportPage />} /><Route path="reports/:name" element={<ReportsPage />} /><Route path="import" element={<ImportPage />} />
        {/* settings */}
        <Route path="settings" element={<SettingsPage />} /><Route path="help" element={<HelpPage />} />
        <Route path="settings/users" element={<UsersPage />} /><Route path="settings/users/:id" element={<UserFormPage />} />
        <Route path="settings/backup" element={<BackupPage />} /><Route path="settings/update" element={<UpdatePage />} /><Route path="settings/password" element={<ChangePasswordPage />} />
        <Route path="settings/telegram" element={<TelegramPage />} /><Route path="settings/share-links" element={<ShareLinksPage />} /><Route path="settings/corrections" element={<CorrectionsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
