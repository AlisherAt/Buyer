import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as XLSX from 'xlsx';
import { cloudEnabled, supabase } from './supabase';
import AdminSubscriptions from './AdminSubscriptions';
import { calcDeal, combinedTaxRate, dealMetrics } from './finance';
import { fetchKaspiRates } from './rates';
import './styles.css';
import './mobile.css';
import './auth.css';

const emptyStore = { settings: { currency: 'KZT', taxRate: 3, paymentFeeRate: 1, autoLaunch: true, showWarehouse: true, theme: 'light', categories: ['Без категории'], exchangeRates: { KZT: '', USD: '', EUR: '', JPY: '', KRW: '' }, rateHistory: [], ratesSource: '', ratesUpdatedAt: '' }, purchases: [], sales: [], expenses: [], taxPayments: [], refunds: [], orders: [], archive: [] };
const money = (value, currency = 'KZT') => new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(value) || 0);
const moneyExact = (value, currency = 'KZT') => new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value) || 0);
const date = () => new Date().toISOString().slice(0, 10);
const uid = () => crypto.randomUUID();
const countries = ['США', 'Япония', 'Корея', 'Европа', 'Другое'];
const purchaseStatuses = ['Заказано', 'В пути', 'На складе', 'Продано'];
const paymentStatuses = ['Полная предоплата', 'Частичная', 'Постоплата', 'Долг'];
const expenseCategories = ['Реклама', 'Упаковка', 'Курьерка', 'Комиссия платёжной системы', 'Прочее'];
const trialDurationMs = 2 * 60 * 60 * 1000;
const browserAPI = {
  getStore: async () => { try { return JSON.parse(localStorage.getItem('buyer-finance-store') || 'null') || emptyStore; } catch { return emptyStore; } },
  saveStore: async data => localStorage.setItem('buyer-finance-store', JSON.stringify(data)),
  setLaunch: async () => false,
  saveBackup: async () => { const blob = new Blob([localStorage.getItem('buyer-finance-store') || JSON.stringify(emptyStore)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'buyer-finance-backup.json'; link.click(); URL.revokeObjectURL(link.href); return true; },
  restoreBackup: async () => null,
  exportPdf: async () => null
};
const cloudAPI = {
  getStore: async () => {
    const { data, error } = await supabase.from('user_stores').select('data,version').maybeSingle();
    if (error) throw error;
    return { store: data?.data || emptyStore, version: data?.version || 0 };
  },
  saveStore: async (data, expectedVersion) => {
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) throw new Error('Сессия истекла');
    const { data: version, error } = await supabase.rpc('save_user_store', { p_data: data, p_expected_version: expectedVersion });
    if (error) throw error;
    return version;
  },
  getProfile: async () => {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    let { data, error } = await supabase.from('profiles').select('user_id,email,role,created_at').eq('user_id', userData.user.id).maybeSingle();
    if (!data && !error) {
      const result = await supabase.from('profiles').insert({ user_id: userData.user.id, email: userData.user.email, role: 'user' }).select('user_id,email,role,created_at').single();
      data = result.data;
      error = result.error;
    }
    if (error) throw error;
    return data;
  },
  getSubscription: async () => {
    const { data, error } = await supabase.from('subscriptions').select('status,plan,current_period_end,is_permanent,amount,currency,updated_at').maybeSingle();
    if (error) throw error;
    return data;
  },
  findProfiles: async email => {
    const { data, error } = await supabase.from('profiles').select('user_id,email').ilike('email', `%${email}%`).limit(10);
    if (error) throw error;
    return data || [];
  },
  saveSubscription: async subscription => {
    const { error } = await supabase.from('subscriptions').upsert({ ...subscription, updated_at: new Date().toISOString() });
    if (error) throw error;
  },
  setLaunch: async () => false,
  saveBackup: browserAPI.saveBackup,
  restoreBackup: browserAPI.restoreBackup,
  exportPdf: browserAPI.exportPdf
};
const storageAPI = session => cloudEnabled && session ? cloudAPI : (window.buyerAPI || browserAPI);
if (!window.buyerAPI) window.buyerAPI = browserAPI;
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));

function calcPurchase(form, mainCurrency = 'KZT', exchangeRates = {}) { const productRate = Number(form.rate || 0); const internalRate = mainCurrency === 'KZT' ? 1 : Number(form.internalDeliveryRate || exchangeRates.KZT || 0); const productCost = Number(form.price || 0) * productRate; const internalDelivery = Number(form.internalDelivery || 0) * internalRate; const internationalDelivery = Number(form.internationalDelivery || 0) * productRate; return productCost + internalDelivery + internationalDelivery + Number(form.customs || 0) + Number(form.agentFee || 0); }
function getCurrencyRate(currency, settings = {}, liveRates = {}) {
  const code = String(currency || 'USD').toUpperCase();
  const stored = settings.exchangeRates?.[code];
  if (stored !== undefined && stored !== null && stored !== '') return String(stored);
  const live = liveRates?.[code];
  return live != null && live !== '' ? String(live) : '';
}
function blankPurchase(settings = {}) { return { date: date(), country: 'США', platform: '', title: '', category: 'Без категории', link: '', price: '', currency: 'USD', rate: getCurrencyRate('USD', settings, {}), internalDelivery: '', internalDeliveryRate: '', internationalDelivery: '', internationalDeliveryRate: '', customs: '', agentFee: '', status: 'Заказано' }; }
function blankSale(settings = {}) { return { date: date(), purchaseId: '', title: '', link: '', client: '', price: '', paymentStatus: 'Полная предоплата', paid: '', buyPrice: '', buyCurrency: 'USD', delivery: '', rate: getCurrencyRate('USD', settings, {}), country: 'США', platform: '', category: 'Без категории' }; }
function snapshotSale(form, taxRate) {
  const calc = calcDeal(form, taxRate);
  return {
    date: form.date,
    purchaseId: form.purchaseId,
    client: form.client || '',
    price: form.price,
    paymentStatus: form.paymentStatus,
    paid: form.paid === '' || form.paid == null ? form.price : form.paid,
    rate: form.rate,
    taxRate,
    taxAmount: calc.tax,
    costAmount: calc.cost,
    profit: calc.profit
  };
}

function AuthScreen({ loading = false }) {
  const [register, setRegister] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const submit = async event => {
    event.preventDefault();
    setError('');
    setSent(false);
    const result = forgot
      ? await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })
      : register ? await supabase.auth.signUp({ email, password }) : await supabase.auth.signInWithPassword({ email, password });
    if (result.error) setError(result.error.message.includes('Invalid login credentials') ? 'Неверный email или пароль' : result.error.message);
    else setSent(true);
  };
  if (loading) return <div className="auth-shell"><div className="auth-card auth-loading"><div className="brand-mark">BF</div><p>Проверяем авторизацию...</p></div></div>;
  return <div className="auth-shell"><div className="auth-card"><div className="auth-brand"><div className="brand-mark">BF</div><div><h1>Учёт байера</h1><p>Облачный доступ с любого устройства</p></div></div><h2>{forgot ? 'Восстановить пароль' : register ? 'Создать аккаунт' : 'Войти в аккаунт'}</h2>{sent && <div className="auth-error" style={{ background: '#dff3e8', color: '#1e705f' }}>{forgot ? 'Ссылка для восстановления отправлена на почту.' : 'Проверьте почту для подтверждения аккаунта.'}</div>}{error && <div className="auth-error">{error}</div>}<form className="auth-form" onSubmit={submit}><label>Email<input type="email" value={email} onChange={event => setEmail(event.target.value)} required autoComplete="email" /></label>{!forgot && <label>Пароль<input type="password" value={password} onChange={event => setPassword(event.target.value)} minLength="6" required autoComplete={register ? 'new-password' : 'current-password'} /></label>}<button className="primary">{forgot ? 'Отправить ссылку' : register ? 'Зарегистрироваться' : 'Войти'}</button></form>{!register && !forgot && <button className="auth-switch" onClick={() => { setForgot(true); setError(''); setSent(false); }}>Забыли пароль?</button>}<button className="auth-switch" onClick={() => { setForgot(false); setRegister(!register); setError(''); setSent(false); }}>{forgot ? 'Вернуться ко входу' : register ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться'}</button></div></div>;
}

function PasswordRecoveryScreen({ onDone }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const update = async event => { event.preventDefault(); const { error: updateError } = await supabase.auth.updateUser({ password }); if (updateError) setError(updateError.message); else onDone(); };
  return <div className="auth-shell"><div className="auth-card"><h2>Новый пароль</h2><p>Введите новый пароль для аккаунта.</p>{error && <div className="auth-error">{error}</div>}<form className="auth-form" onSubmit={update}><label>Новый пароль<input type="password" minLength="6" value={password} onChange={event => setPassword(event.target.value)} required /></label><button className="primary">Сохранить пароль</button></form></div></div>;
}

function SubscriptionStatus({ subscription }) {
  const [history, setHistory] = useState([]);
  useEffect(() => {
    if (!subscription || !cloudEnabled) return;
    supabase.from('subscription_history').select('status,plan,current_period_end,is_permanent,created_at').order('created_at', { ascending: false }).limit(5).then(({ data }) => setHistory(data || []));
  }, [subscription?.updated_at]);
  if (!subscription || subscription.status !== 'active') return null;
  if (subscription.is_permanent) return <div className="subscription-status permanent-status">Бессрочный доступ активен{history.length > 0 && <details className="subscription-history"><summary>История продлений ({history.length})</summary>{history.map((item, index) => <small key={`${item.created_at}-${index}`}>{new Date(item.created_at).toLocaleDateString('ru-RU')} · {item.is_permanent ? 'бессрочный доступ' : `до ${new Date(item.current_period_end).toLocaleDateString('ru-RU')}`}</small>)}</details>}</div>;
  const remaining = Math.max(0, new Date(subscription.current_period_end).getTime() - Date.now());
  const days = Math.ceil(remaining / 86400000);
  return <div className="subscription-status">Подписка активна · осталось дней: <strong>{days}</strong> · до {new Date(subscription.current_period_end).toLocaleDateString('ru-RU')}{history.length > 0 && <details className="subscription-history"><summary>История продлений ({history.length})</summary>{history.map((item, index) => <small key={`${item.created_at}-${index}`}>{new Date(item.created_at).toLocaleDateString('ru-RU')} · {item.is_permanent ? 'бессрочный доступ' : `до ${new Date(item.current_period_end).toLocaleDateString('ru-RU')}`}</small>)}</details>}</div>;
}

function FinancialAlerts({ metrics, store, subscription }) {
  const debtCount = store.sales.filter(sale => Number(sale.price || 0) > Number(sale.paid || 0)).length;
  const taxDue = Math.max(0, metrics.taxes - store.taxPayments.reduce((sum, item) => sum + Number(item.amount || 0), 0));
  const subscriptionDays = subscription?.current_period_end ? Math.ceil((new Date(subscription.current_period_end) - Date.now()) / 86400000) : null;
  const alerts = [debtCount > 0 && `Дебиторская задолженность: ${debtCount} ${debtCount === 1 ? 'клиент' : 'клиентов'}`, taxDue > 0 && `Налоговый резерв: ${money(taxDue, store.settings.currency)}`, subscriptionDays !== null && subscriptionDays >= 0 && subscriptionDays <= 7 && `Подписка закончится через ${subscriptionDays} дн.`].filter(Boolean);
  return alerts.length ? <div className="financial-alerts">{alerts.map(message => <span key={message}>⚠ {message}</span>)}</div> : null;
}

function LegalPage({ type, onBack }) {
  const privacy = type === 'privacy';
  return <section className="panel legal-page"><button className="text-btn" onClick={onBack}>← Вернуться</button><p className="eyebrow">ИНФОРМАЦИЯ</p><h2>{privacy ? 'Политика конфиденциальности' : 'Условия использования'}</h2>{privacy ? <><p>Мы используем email для авторизации и храним финансовые данные аккаунта в защищённой базе Supabase.</p><p>Данные доступны только владельцу аккаунта и администраторам сервиса для управления подпиской.</p><p>Мы не передаём данные третьим лицам, кроме сервисов, необходимых для работы приложения.</p></> : <><p>Приложение предоставляет инструменты для учёта закупок, продаж, расходов и финансовых результатов.</p><p>Пробный период предоставляется на 2 часа. Доступ после его окончания возможен при активной подписке.</p><p>Вопросы по подписке, продлению и возвратам согласовываются с администратором.</p></>}</section>;
}

function SubscriptionScreen({ subscription, onSignOut }) {
  const expired = subscription?.current_period_end ? new Date(subscription.current_period_end).toLocaleDateString('ru-RU') : null;
  const whatsappUrl = 'https://wa.me/77006520335?text=' + encodeURIComponent('Здравствуйте! Хочу продлить подписку на Учёт байера.');
  return <div className="auth-shell"><div className="auth-card subscription-card"><div className="auth-brand"><div className="brand-mark">BF</div><div><h1>Учёт байера</h1><p>Доступ к облачному учёту</p></div></div><h2>Пробный период завершён</h2><p>{expired ? `Доступ закончился ${expired}.` : 'Ваш бесплатный пробный период завершён.'} Данные аккаунта сохранены.</p><div className="subscription-offer"><strong>Продолжить работу</strong><span>15 000 ₸ / месяц</span><small>Напишите администратору в WhatsApp, чтобы согласовать подписку. После подтверждения доступ к вашим данным будет восстановлен.</small></div><a className="primary full whatsapp-button" href={whatsappUrl} target="_blank" rel="noreferrer">Написать в WhatsApp</a><button className="secondary full" onClick={onSignOut}>Выйти</button></div></div>;
}

function App() {
  const [session, setSession] = useState(null);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [profile, setProfile] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [accountLoading, setAccountLoading] = useState(cloudEnabled);
  const [trialNow, setTrialNow] = useState(Date.now());
  const [authLoading, setAuthLoading] = useState(cloudEnabled);
  const [store, setStore] = useState(emptyStore);
  const [page, setPage] = useState('overview');
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState('');
  const [syncStatus, setSyncStatus] = useState('Синхронизировано');
  const storeVersion = useRef(0);
  const [period, setPeriod] = useState('month');
  const [theme, setTheme] = useState('light');
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [liveRates, setLiveRates] = useState(null);
  useEffect(() => {
    if (!cloudEnabled) return;
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthLoading(false); });
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => { setSession(nextSession); setPasswordRecovery(event === 'PASSWORD_RECOVERY'); });
    return () => listener.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (cloudEnabled && !session) return;
    storageAPI(session).getStore().then(result => { const data = result?.store || result; storeVersion.current = result?.version || 0; const next = { ...emptyStore, ...data, settings: { ...emptyStore.settings, ...data.settings, exchangeRates: { ...emptyStore.settings.exchangeRates, ...data.settings?.exchangeRates }, rateHistory: data.settings?.rateHistory || [] } }; ['purchases', 'sales', 'expenses', 'taxPayments', 'refunds', 'orders', 'archive'].forEach(key => { if (!Array.isArray(next[key])) next[key] = []; }); setStore(next); setTheme(next.settings.theme); }).catch(() => notify('Не удалось загрузить облачные данные'));
  }, [session]);
  useEffect(() => {
    if (!session || !cloudEnabled) return;
    Promise.allSettled([cloudAPI.getProfile(), cloudAPI.getSubscription()]).then(([profileResult, subscriptionResult]) => {
      const fallbackProfile = { user_id: session.user.id, email: session.user.email, role: 'user', created_at: session.user.created_at };
      setProfile(profileResult.status === 'fulfilled' ? profileResult.value : fallbackProfile);
      setSubscription(subscriptionResult.status === 'fulfilled' ? subscriptionResult.value : null);
    }).finally(() => setAccountLoading(false));
  }, [session]);
  useEffect(() => {
    if (!session || !cloudEnabled) return undefined;
    let active = true;
    const refreshSubscription = async () => {
      const nextSubscription = await cloudAPI.getSubscription().catch(() => undefined);
      if (active && nextSubscription !== undefined) setSubscription(nextSubscription);
    };
    const timer = setInterval(refreshSubscription, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [session]);
  useEffect(() => {
    if (!profile?.created_at) return undefined;
    const timer = setInterval(() => setTrialNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [profile?.created_at]);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    let active = true;
    fetchKaspiRates().then(rates => { if (active) setLiveRates(rates); }).catch(() => {});
    return () => { active = false; };
  }, [session]);
  const persist = (next) => { setStore(next); setSyncStatus('Сохраняем...'); return storageAPI(session).saveStore(next, storeVersion.current).then(result => { if (typeof result === 'number') storeVersion.current = result; setSyncStatus('Сохранено'); return result; }).catch(error => { const message = error.message || ''; const conflict = /conflict|изменены на другом устройстве/i.test(message); const revoked = /access denied|permission denied|inactive|expired/i.test(message); setSyncStatus(revoked ? 'Доступ отключён' : conflict ? 'Есть более новая версия' : 'Ошибка синхронизации'); notify(revoked ? 'Доступ к аккаунту отключён.' : conflict ? 'Данные изменены на другом устройстве. Обновите страницу перед повторным сохранением.' : 'Не удалось сохранить данные'); if (revoked && cloudEnabled) supabase.auth.signOut(); throw error; }); };
  const notify = (text) => { setToast(text); setTimeout(() => setToast(''), 2600); };
  const purchaseById = (id) => store.purchases.find(item => item.id === id);
  const sales = useMemo(() => store.sales.map(sale => ({ ...sale, purchase: purchaseById(sale.purchaseId) })), [store.sales, store.purchases]);
  const periodRange = useMemo(() => { const end = new Date(); const start = new Date(end); if (period === 'week') start.setDate(end.getDate() - 6); if (period === 'month') start.setDate(1); if (period === 'quarter') start.setMonth(end.getMonth() - 2, 1); return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) }; }, [period]);
  const inPeriod = item => !item.date || (item.date >= periodRange.from && item.date <= periodRange.to);
  const periodSales = sales.filter(inPeriod);
  const periodExpenses = store.expenses.filter(inPeriod);
  const metrics = useMemo(() => {
    const taxRate = combinedTaxRate(store.settings);
    const rows = periodSales.map(sale => dealMetrics(sale, sale.purchase, taxRate));
    const revenue = rows.reduce((sum, row) => sum + row.salePrice, 0);
    const cost = rows.reduce((sum, row) => sum + row.cost, 0);
    const taxes = rows.reduce((sum, row) => sum + row.tax, 0);
    const expenses = periodExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const debts = sales.reduce((sum, s) => sum + Math.max(0, Number(s.price || 0) - Number(s.paid || 0)), 0);
    const profit = rows.reduce((sum, row) => sum + row.profit, 0) - expenses;
    const margin = revenue ? (profit / revenue) * 100 : 0;
    return { revenue, cost, expenses, taxes, debts, profit, average: periodSales.length ? revenue / periodSales.length : 0, margin };
  }, [periodSales, periodExpenses, sales, store.settings.taxRate]);
  const filteredSales = periodSales;
  const addPurchase = (form) => { const item = { ...form, id: uid(), totalCost: calcPurchase(form, store.settings.currency, store.settings.exchangeRates), createdAt: Date.now() }; persist({ ...store, purchases: [item, ...store.purchases] }); setModal(null); notify('Закупка сохранена'); };
  const updatePurchase = (form, editing) => { const item = { ...form, id: editing.id, totalCost: calcPurchase(form, store.settings.currency, store.settings.exchangeRates), createdAt: editing.createdAt }; persist({ ...store, purchases: store.purchases.map(p => p.id === item.id ? item : p) }); setModal(null); notify('Закупка обновлена'); };
  const addSale = (form) => {
    const taxRate = combinedTaxRate(store.settings);
    const paid = form.paid === '' || form.paid == null ? form.price : form.paid;
    if (!form.title && !form.purchaseId) return notify('Укажите наименование');
    if (Number(form.price) < 0 || Number(paid) < 0 || Number(paid) > Number(form.price)) return notify('Проверьте цену и сумму оплаты');
    if (!Number(form.rate)) return notify('Укажите курс валюты');
    let purchases = store.purchases;
    let purchaseId = form.purchaseId;
    if (purchaseId) {
      const purchase = store.purchases.find(item => item.id === purchaseId);
      if (!purchase || purchase.status === 'Продано') return notify('Товар уже продан или не найден');
      const nextPurchase = { ...purchase, title: form.title || purchase.title, link: form.link || purchase.link, price: form.buyPrice, currency: form.buyCurrency || purchase.currency, rate: form.rate, internationalDelivery: form.delivery, status: 'Продано', totalCost: calcDeal(form, taxRate).cost };
      purchases = store.purchases.map(item => item.id === purchaseId ? nextPurchase : item);
    } else {
      const purchase = { ...blankPurchase(), id: uid(), createdAt: Date.now(), date: form.date, title: form.title, link: form.link, country: form.country || 'США', platform: form.platform || '', category: form.category || 'Без категории', price: form.buyPrice, currency: form.buyCurrency || 'USD', rate: form.rate, internationalDelivery: form.delivery, status: 'Продано', totalCost: calcDeal(form, taxRate).cost };
      purchaseId = purchase.id;
      purchases = [purchase, ...store.purchases];
    }
    const item = { ...snapshotSale({ ...form, purchaseId, paid }, taxRate), id: uid(), createdAt: Date.now() };
    persist({ ...store, sales: [item, ...store.sales], purchases }).then(() => { setModal(null); notify('Сделка сохранена'); }).catch(() => {});
  };
  const updateSale = (form, editing) => {
    const taxRate = combinedTaxRate(store.settings);
    const paid = form.paid === '' || form.paid == null ? form.price : form.paid;
    if (Number(form.price) < 0 || Number(paid) < 0 || Number(paid) > Number(form.price) || !Number(form.rate)) return notify('Проверьте суммы и курс');
    let purchaseId = form.purchaseId || editing.purchaseId;
    let purchases = store.purchases;
    const existing = store.purchases.find(item => item.id === purchaseId);
    if (existing) {
      const occupied = store.sales.some(sale => sale.id !== editing.id && sale.purchaseId === purchaseId);
      if (occupied) return notify('Этот товар уже привязан к другой продаже');
      purchases = store.purchases.map(item => {
        if (item.id === editing.purchaseId && item.id !== purchaseId && item.status === 'Продано') return { ...item, status: 'На складе' };
        if (item.id === purchaseId) return { ...item, title: form.title || item.title, link: form.link || item.link, price: form.buyPrice, currency: form.buyCurrency || item.currency, rate: form.rate, internationalDelivery: form.delivery, status: 'Продано', totalCost: calcDeal(form, taxRate).cost };
        return item;
      });
    } else {
      const purchase = { ...blankPurchase(), id: uid(), createdAt: Date.now(), date: form.date, title: form.title, link: form.link, price: form.buyPrice, currency: form.buyCurrency || 'USD', rate: form.rate, internationalDelivery: form.delivery, status: 'Продано', totalCost: calcDeal(form, taxRate).cost };
      purchaseId = purchase.id;
      purchases = [purchase, ...store.purchases];
    }
    const item = { ...snapshotSale({ ...form, purchaseId, paid }, taxRate), id: editing.id, createdAt: editing.createdAt };
    persist({ ...store, sales: store.sales.map(sale => sale.id === item.id ? item : sale), purchases }).then(() => { setModal(null); notify('Сделка обновлена'); }).catch(() => {});
  };
  const addExpense = (form) => { if (Number(form.amount) < 0) return notify('Сумма расхода не может быть отрицательной'); persist({ ...store, expenses: [{ ...form, id: uid(), createdAt: Date.now() }, ...store.expenses] }).then(() => { setModal(null); notify('Расход сохранен'); }).catch(() => {}); };
  const updateExpense = (form, editing) => { if (Number(form.amount) < 0) return notify('Сумма расхода не может быть отрицательной'); persist({ ...store, expenses: store.expenses.map(item => item.id === editing.id ? { ...form, id: editing.id, createdAt: editing.createdAt } : item) }).then(() => { setModal(null); notify('Расход обновлен'); }).catch(() => {}); };
  const updateSettings = (patch) => { const changedRates = patch.exchangeRates ? Object.entries(patch.exchangeRates).filter(([currency, value]) => String(value) !== String(store.settings.exchangeRates?.[currency] ?? '')).map(([currency, rate]) => ({ currency, rate, date: new Date().toISOString() })) : []; const history = changedRates.length ? [...changedRates, ...(store.settings.rateHistory || []).filter(item => !changedRates.some(change => change.currency === item.currency && item.date.slice(0, 10) === change.date.slice(0, 10)))].slice(0, 100) : (store.settings.rateHistory || []); const next = { ...store, settings: { ...store.settings, ...patch, rateHistory: history } }; persist(next); if (patch.autoLaunch !== undefined) storageAPI(session).setLaunch(patch.autoLaunch); if (patch.theme) setTheme(patch.theme); };
  const refreshKaspiRate = async (silent = false) => {
    try {
      const rates = await fetchKaspiRates();
      updateSettings({
        exchangeRates: { ...store.settings.exchangeRates, USD: String(Number(rates.USD.toFixed(2))), EUR: rates.EUR ? String(Number(rates.EUR.toFixed(4))) : store.settings.exchangeRates?.EUR, JPY: rates.JPY ? String(Number(rates.JPY.toFixed(4))) : store.settings.exchangeRates?.JPY, KRW: rates.KRW ? String(Number(rates.KRW.toFixed(4))) : store.settings.exchangeRates?.KRW },
        ratesSource: rates.source,
        ratesUpdatedAt: rates.fetchedAt
      });
      if (!silent) notify(`Курс Каспи обновлён: ${Number(rates.USD).toFixed(2)} ₸ за $1`);
      setLiveRates(rates);
      return rates;
    } catch {
      if (!silent) notify('Не удалось получить курс. Введите его вручную — как снял Каспи.');
      return null;
    }
  };
  const restoreBackup = () => storageAPI(session).restoreBackup().then(data => { if (!data) return notify('Восстановление доступно в приложении Windows'); const next = { ...emptyStore, ...data, settings: { ...emptyStore.settings, ...data.settings, exchangeRates: { ...emptyStore.settings.exchangeRates, ...data.settings?.exchangeRates } } }; ['purchases', 'sales', 'expenses', 'taxPayments', 'refunds'].forEach(key => { if (!Array.isArray(next[key])) next[key] = []; }); setStore(next); setTheme(next.settings.theme); notify('Данные восстановлены'); }).catch(error => notify(error.message || 'Не удалось восстановить копию'));
  const csvExport = () => { const rows = [['Дата', 'Товар', 'Страна', 'Продажа', 'Себестоимость', 'Маржа'], ...filteredSales.map(s => [s.date, s.purchase?.title || '', s.purchase?.country || '', Number(s.price || 0), Number(s.purchase?.totalCost || 0), Number(s.price || 0) - Number(s.purchase?.totalCost || 0)])]; const workbook = XLSX.utils.book_new(); const sheet = XLSX.utils.aoa_to_sheet(rows); XLSX.utils.book_append_sheet(workbook, sheet, 'Отчёт'); XLSX.writeFile(workbook, 'buyer-report.xlsx'); notify('Excel-файл сохранен'); };
  const pdfExport = () => { const html = `<html><body style="font-family:Arial;padding:32px"><h1>Отчёт учёта байера</h1><p>Сформирован: ${date()}</p><h2>Выручка: ${money(metrics.revenue, store.settings.currency)}</h2><p>Себестоимость: ${money(metrics.cost, store.settings.currency)}</p><p>Операционные расходы: ${money(metrics.expenses, store.settings.currency)}</p><p>Налоги: ${money(metrics.taxes, store.settings.currency)}</p><h2>Чистая прибыль: ${money(metrics.profit, store.settings.currency)}</h2></body></html>`; storageAPI(session).exportPdf(html).then(path => path && notify('PDF сохранен')); };
  const navigate = nextPage => { setPage(nextPage); setMenuOpen(false); };

  if (authLoading) return <AuthScreen loading />;
  if (cloudEnabled && !session) return <AuthScreen />;
  if (cloudEnabled && passwordRecovery) return <PasswordRecoveryScreen onDone={() => setPasswordRecovery(false)} />;
  if (cloudEnabled && accountLoading) return <AuthScreen loading />;
  const trialEnd = (profile?.created_at || session?.user?.created_at) ? new Date(profile?.created_at || session.user.created_at).getTime() + trialDurationMs : 0;
  const inTrial = profile?.role !== 'admin' && trialEnd > trialNow;
  const trialRemaining = Math.max(0, trialEnd - trialNow);
  const trialHours = Math.floor(trialRemaining / 3600000);
  const trialMinutes = Math.floor((trialRemaining % 3600000) / 60000);
  const trialSeconds = Math.floor((trialRemaining % 60000) / 1000);
  const accessRevoked = subscription?.status === 'inactive';
  const hasAccess = profile?.role === 'admin' || (!accessRevoked && (inTrial || (subscription?.status === 'active' && (subscription.is_permanent || (subscription.current_period_end && new Date(subscription.current_period_end) > new Date())))));
  if (cloudEnabled && !hasAccess) return <SubscriptionScreen subscription={subscription} onSignOut={() => supabase.auth.signOut()} />;
  return <div className={`app-shell ${menuOpen ? 'menu-open' : ''}`}>
    <div className="mobile-menu-backdrop" onClick={() => setMenuOpen(false)}></div>
    <aside className="sidebar">
      <button className="mobile-menu-close" aria-label="Закрыть меню" onClick={() => setMenuOpen(false)}>×</button>
      <div className="brand"><div className="brand-mark">BF</div><div><strong>УЧЁТ БАЙЕРА</strong><span>Локальная система</span></div></div>
      <nav>{[['overview', 'Обзор', '⌂'], ['sales', 'Сделки', '↗'], ['purchases', 'Склад / выкуп', '↘'], ['expenses', 'Расходы', '◌'], ['debts', 'Дебиторка', '◷'], ['warehouse', 'Склад', '▦'], ['taxes', 'Налоги', '₽'], ['reports', 'Отчёты', '▤'], ...(profile?.role === 'admin' ? [['admin', 'Админ-панель', '♙']] : [])].map(([id, label, icon]) => (id !== 'warehouse' || store.settings.showWarehouse) && <button className={page === id ? 'nav-item active' : 'nav-item'} onClick={() => navigate(id)} key={id}><i>{icon}</i>{label}{id === 'debts' && metrics.debts > 0 && <b>{money(metrics.debts, store.settings.currency)}</b>}</button>)}</nav>
      <div className="sidebar-bottom"><button className="nav-item" onClick={() => navigate('settings')}><i>⚙</i>Настройки</button><button className="nav-item" onClick={() => navigate('terms')}><i>§</i>Условия</button><button className="nav-item" onClick={() => navigate('privacy')}><i>⌁</i>Конфиденциальность</button><div className="offline"><span></span><div><strong>Облачная синхронизация</strong><small>Данные привязаны к аккаунту</small></div></div></div>
    </aside>
    <main className="main"><header><button className="mobile-menu-button" aria-label="Открыть меню" onClick={() => setMenuOpen(true)}>☰</button><div><p className="eyebrow">ФИНАНСОВЫЙ ЦЕНТР</p><h1>{({ overview: 'Добрый день', purchases: 'Склад / выкуп', sales: 'Сделки под заказ', expenses: 'Операционные расходы', debts: 'Дебиторка', warehouse: 'Склад', taxes: 'Налоги', reports: 'Отчёты', settings: 'Настройки', admin: 'Админ-панель', terms: 'Условия использования', privacy: 'Конфиденциальность' })[page]}</h1></div><div className="header-actions"><span className="sync-status">{syncStatus}</span>{liveRates?.USD && <span className="sync-status" title={liveRates.source}>$ {Number(liveRates.USD).toFixed(2)} ₸</span>}<button className="icon-btn" title="Переключить тему" onClick={() => updateSettings({ theme: theme === 'light' ? 'dark' : 'light' })}>{theme === 'light' ? '☾' : '☀'}</button><button className="avatar" title="Выйти" onClick={() => cloudEnabled ? supabase.auth.signOut() : null}>Б</button></div></header>
      <FinancialAlerts metrics={metrics} store={store} subscription={subscription} />
      {inTrial && profile?.role !== 'admin' && <div className="trial-banner">Пробный период: <strong>{trialHours} ч {String(trialMinutes).padStart(2, '0')} мин {String(trialSeconds).padStart(2, '0')} сек</strong></div>}
      {profile?.role !== 'admin' && !inTrial && <SubscriptionStatus subscription={subscription} />}
      {page === 'overview' && <Overview metrics={metrics} store={store} setModal={setModal} setPage={setPage} period={period} setPeriod={setPeriod} sales={filteredSales} allSales={sales} liveRates={liveRates} />}
      {page === 'purchases' && <Purchases store={store} setModal={setModal} persist={persist} notify={notify} query={query} setQuery={setQuery} />}
      {page === 'sales' && <Sales sales={sales} store={store} setModal={setModal} persist={persist} notify={notify} query={query} setQuery={setQuery} />}
      {page === 'expenses' && <Expenses store={store} setModal={setModal} persist={persist} notify={notify} query={query} setQuery={setQuery} />}
      {page === 'debts' && <Debts store={store} sales={sales} metrics={metrics} persist={persist} />}
      {page === 'warehouse' && <Warehouse store={store} />}
      {page === 'taxes' && <Taxes store={store} metrics={metrics} persist={persist} />}
      {page === 'reports' && <Reports metrics={metrics} sales={sales} store={store} csvExport={csvExport} pdfExport={pdfExport} />}
      {page === 'settings' && <Settings store={store} updateSettings={updateSettings} notify={notify} restoreBackup={restoreBackup} profile={profile} liveRates={liveRates} refreshKaspiRate={refreshKaspiRate} />}
      {page === 'admin' && profile?.role === 'admin' && <AdminSubscriptions notify={notify} />}
      {page === 'terms' && <LegalPage type="terms" onBack={() => navigate('overview')} />}
      {page === 'privacy' && <LegalPage type="privacy" onBack={() => navigate('overview')} />}
    </main>
    {(modal === 'purchase' || modal?.type === 'purchase') && <PurchaseModal value={modal?.value} onSave={modal?.value ? updatePurchase : addPurchase} onClose={() => setModal(null)} settings={store.settings} liveRates={liveRates} />}
    {(modal === 'sale' || modal?.type === 'sale') && <DealModal value={modal?.value} onSave={modal?.value ? updateSale : addSale} onClose={() => setModal(null)} purchases={store.purchases.filter(p => p.status !== 'Продано' || p.id === modal?.value?.purchaseId)} settings={store.settings} liveRates={liveRates} refreshKaspiRate={refreshKaspiRate} />}
    {(modal === 'expense' || modal?.type === 'expense') && <ExpenseModal value={modal?.value} onSave={modal?.value ? updateExpense : addExpense} onClose={() => setModal(null)} currency={store.settings.currency} />}
    {toast && <div className="toast">✓ {toast}</div>}
  </div>;
}

function Overview({ metrics, store, setModal, setPage, period, setPeriod, sales, allSales, liveRates }) { return <>
  <Calendar sales={allSales} currency={store.settings.currency} />
  <div className="toolbar"><div className="periods">{[['week','Неделя'],['month','Месяц'],['quarter','Квартал']].map(([v,l]) => <button className={period === v ? 'selected' : ''} onClick={() => setPeriod(v)} key={v}>{l}</button>)}</div><button className="secondary" onClick={() => setPage('reports')}>Открыть отчёт <span>→</span></button></div>
  <section className="metric-grid"><Metric label="Выручка" value={metrics.revenue} currency={store.settings.currency} icon="↗" tone="green" hint="за выбранный период" /><Metric label="Чистая прибыль" value={metrics.profit} currency={store.settings.currency} icon="◎" tone="blue" hint={`маржа ${metrics.margin.toFixed(1)}%`} /><Metric label="Резерв на налоги" value={metrics.taxes} currency={store.settings.currency} icon="▣" tone="orange" hint={`${store.settings.taxRate}% с продаж`} /><Metric label="Долги клиентов" value={metrics.debts} currency={store.settings.currency} icon="◷" tone="red" hint="к получению" /></section>
  <div className="quick-actions"><button onClick={() => setModal({ type: 'sale' })}><span>↗</span><div><strong>Новая сделка</strong><small>Продала → выкупила → прибыль считается сама</small></div></button><button onClick={() => setModal({ type: 'purchase' })}><span>＋</span><div><strong>Выкуп на склад</strong><small>Редкие товары в наличии</small></div></button><button onClick={() => setModal({ type: 'expense' })}><span>−</span><div><strong>Операционный расход</strong><small>Реклама, упаковка, доставка клиенту</small></div></button></div>
  {liveRates?.USD && <p className="subtle rate-banner">Курс Каспи сейчас: <strong>{Number(liveRates.USD).toFixed(2)} ₸ за $1</strong>{liveRates.source ? ` · ${liveRates.source}` : ''}. Если банк снял больше — поправьте в сделке.</p>}
  <div className="content-grid"><section className="panel chart-panel"><div className="panel-heading"><div><p className="eyebrow">ДИНАМИКА</p><h2>Денежный поток</h2></div><span className="legend"><i className="dot green"></i>Выручка <i className="dot blue"></i>Расходы</span></div><div className="chart"><div className="chart-y"><span>100k</span><span>75k</span><span>50k</span><span>25k</span><span>0</span></div><div className="bars">{[38, 64, 48, 82, 57, 76, 91].map((height, index) => <div className="bar-group" key={index}><div className="bar income" style={{ height: `${height}%` }}></div><div className="bar cost" style={{ height: `${Math.max(12, height - 38)}%` }}></div><small>{['Пн','Вт','Ср','Чт','Пт','Сб','Вс'][index]}</small></div>)}</div></div></section><section className="panel"><div className="panel-heading"><div><p className="eyebrow">ПОСЛЕДНИЕ</p><h2>Сделки</h2></div><button className="text-btn" onClick={() => setPage('sales')}>Все сделки →</button></div>{sales.slice(0, 4).map(s => { const row = dealMetrics(s, s.purchase, store.settings.taxRate); return <div className="list-row" key={s.id}><div className="row-icon">{(s.purchase?.title || 'Т').slice(0,1)}</div><div className="row-main"><strong>{s.purchase?.title || 'Товар удален'}</strong><small>{s.client || 'Без клиента'} · {s.date}</small></div><strong className={row.profit >= 0 ? 'positive' : 'negative'}>{row.profit >= 0 ? '+' : ''}{money(row.profit, store.settings.currency)}</strong></div>; })}{!sales.length && <Empty text="Сделок пока нет" />}</section></div>
</>; }
function Calendar({ sales, currency }) {
  const [calendarDate, setCalendarDate] = useState(() => new Date());
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const earningsByDay = sales.filter(sale => sale.date?.startsWith(monthKey)).reduce((result, sale) => {
    result[sale.date] = (result[sale.date] || 0) + Number(sale.price || 0);
    return result;
  }, {});
  const firstDay = new Date(year, month, 1).getDay() || 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [...Array(firstDay - 1).fill(null), ...Array.from({ length: daysInMonth }, (_, index) => index + 1)];
  const monthName = calendarDate.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  const shiftMonth = offset => setCalendarDate(new Date(year, month + offset, 1));
  const monthTotal = Object.values(earningsByDay).reduce((sum, value) => sum + value, 0);
  const bestDay = Object.entries(earningsByDay).sort(([, first], [, second]) => second - first)[0];
  const activeDays = Object.keys(earningsByDay).length;
  const averageDay = activeDays ? monthTotal / activeDays : 0;
  return <section className="panel calendar-panel"><div className="panel-heading"><div><p className="eyebrow">ПЛАНИРОВАНИЕ ДОХОДА</p><h2>Календарь заработка</h2></div><div className="calendar-controls"><button className="icon-btn" onClick={() => shiftMonth(-1)} aria-label="Предыдущий месяц">‹</button><strong>{monthName}</strong><button className="icon-btn" onClick={() => shiftMonth(1)} aria-label="Следующий месяц">›</button></div></div><div className="calendar-weekdays">{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(day => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{cells.map((day, index) => { const key = day ? `${monthKey}-${String(day).padStart(2, '0')}` : `empty-${index}`; return <div className={`calendar-day ${day && earningsByDay[key] ? 'has-earnings' : ''}`} key={key}>{day && <><span>{day}</span>{earningsByDay[key] && <strong>+{money(earningsByDay[key], currency)}</strong>}</>}</div>; })}</div><div className="calendar-total"><span>Заработано за месяц</span><strong>{money(monthTotal, currency)}</strong></div><div className="calendar-stats"><span>Продаж <strong>{monthSalesCount(sales, monthKey)}</strong></span><span>Дней с доходом <strong>{activeDays}</strong></span><span>Среднее за день <strong>{money(averageDay, currency)}</strong></span><span>Лучший день <strong>{bestDay ? `${bestDay[0].slice(-2)} · ${money(bestDay[1], currency)}` : '—'}</strong></span></div></section>;
}
function monthSalesCount(sales, monthKey) { return sales.filter(sale => sale.date?.startsWith(monthKey)).length; }
function Metric({ label, value, currency, icon, tone, hint }) { return <div className="metric"><div className={`metric-icon ${tone}`}>{icon}</div><div><span>{label}</span><strong>{money(value, currency)}</strong><small>{hint}</small></div></div>; }
function Empty({ text }) { return <div className="empty">{text}</div>; }
function SectionHeader({ title, count, action, onAction, query, setQuery }) { return <div className="section-head"><div><p className="eyebrow">УЧЁТ</p><h2>{title} <em>{count}</em></h2></div><div className="section-actions">{setQuery && <div className="search"><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Поиск..." /></div>}{action && <button className="primary" onClick={onAction}>＋ {action}</button>}</div></div>; }
function ImportPurchases({ store, persist, notify }) { const load = async event => { const file = event.target.files?.[0]; if (!file) return; try { const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' }); const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' }); const purchases = rows.map(row => { const item = { ...blankPurchase(), id: uid(), createdAt: Date.now(), date: String(row['Дата'] || row.date || date()).slice(0, 10), title: row['Товар'] || row.title || row['Название'] || '', country: row['Страна'] || row.country || 'США', platform: row['Площадка'] || row.platform || '', category: row['Категория'] || row.category || 'Без категории', price: row['Цена'] || row.price || '', currency: row['Валюта'] || row.currency || 'USD', rate: row['Курс'] || row.rate || '', status: row['Статус'] || row.status || 'Заказано' }; return { ...item, totalCost: calcPurchase(item, store.settings.currency, store.settings.exchangeRates) }; }).filter(item => item.title && Number(item.price) >= 0); if (!purchases.length) return notify('Не найдены строки с названием товара'); await persist({ ...store, purchases: [...purchases, ...store.purchases] }); notify(`Импортировано закупок: ${purchases.length}`); } catch { notify('Не удалось прочитать Excel/CSV-файл'); } finally { event.target.value = ''; } }; return <label className="import-purchases secondary">↑ Импорт Excel / CSV<input type="file" accept=".csv,.xlsx,.xls" onChange={load} /></label>; }
function Purchases({ store, setModal, persist, notify, query, setQuery }) { const items = store.purchases.filter(p => !query || `${p.title} ${p.platform} ${p.country}`.toLowerCase().includes(query.toLowerCase())); const remove = itemId => { const item = store.purchases.find(p => p.id === itemId); if (store.sales.some(sale => sale.purchaseId === itemId)) return notify('Нельзя архивировать товар, связанный с продажей'); if (!window.confirm('Переместить эту закупку в архив?')) return; persist({ ...store, purchases: store.purchases.filter(p => p.id !== itemId), archive: [{ ...item, entity: 'purchase', archivedAt: new Date().toISOString() }, ...(store.archive || [])] }).then(() => notify('Закупка перемещена в архив')).catch(() => {}); }; return <><SectionHeader title="Все закупки" count={items.length} action="Новая закупка" onAction={() => setModal('purchase')} query={query} setQuery={setQuery} /><ImportPurchases store={store} persist={persist} notify={notify} /><div className="table-panel"><table><thead><tr><th>Товар</th><th>Дата</th><th>Страна / площадка</th><th>Валюта</th><th>Себестоимость</th><th>Статус</th><th></th></tr></thead><tbody>{items.map(p => <tr key={p.id}><td><strong>{p.title}</strong><small>{p.category}</small></td><td>{p.date}</td><td>{p.country}<small>{p.platform || '—'}</small></td><td>{p.price} {p.currency}</td><td><strong>{money(p.totalCost, store.settings.currency)}</strong></td><td><span className={`status ${p.status === 'На складе' ? 'stock' : p.status === 'Продано' ? 'sold' : ''}`}>{p.status}</span></td><td className="row-actions"><button onClick={() => setModal({ type: 'purchase', value: p })}>Изменить</button><button className="delete-btn" title="В архив" onClick={() => remove(p.id)}>⌫</button></td></tr>)}</tbody></table>{!items.length && <Empty text="Закупок не найдено" />}</div></>; }
function LegacySales({ sales, store, setModal, persist, notify, query, setQuery }) { const items = sales.filter(s => !query || `${s.purchase?.title} ${s.client}`.toLowerCase().includes(query.toLowerCase())); const remove = itemId => { persist({ ...store, sales: store.sales.filter(s => s.id !== itemId) }); notify('Продажа удалена'); }; return <><SectionHeader title="Все продажи" count={items.length} action="Новая продажа" onAction={() => setModal('sale')} query={query} setQuery={setQuery} /><div className="table-panel"><table><thead><tr><th>Товар</th><th>Дата</th><th>Клиент</th><th>Цена продажи</th><th>Получено</th><th>Маржа</th><th>Оплата</th><th></th></tr></thead><tbody>{items.map(s => { const margin = Number(s.price || 0) - Number(s.purchase?.totalCost || 0); return <tr key={s.id}><td><strong>{s.purchase?.title || '—'}</strong><small>{s.purchase?.country}</small></td><td>{s.date}</td><td>{s.client || '—'}</td><td><strong>{money(s.price, store.settings.currency)}</strong></td><td>{money(s.paid, store.settings.currency)}</td><td className={margin >= 0 ? 'positive' : 'negative'}>{money(margin, store.settings.currency)}</td><td><span className="status">{s.paymentStatus}</span></td><td className="row-actions"><button onClick={() => setModal({ type: 'sale', value: s })}>Изменить</button><button className="delete-btn" onClick={() => remove(s.id)}>×</button></td></tr>; })}</tbody></table>{!items.length && <Empty text="Продаж не найдено" />}</div></>; }
function Expenses({ store, setModal, persist, notify, query, setQuery }) { const items = store.expenses.filter(e => !query || `${e.category} ${e.comment}`.toLowerCase().includes(query.toLowerCase())); const remove = itemId => { if (!window.confirm('Удалить этот расход?')) return; persist({ ...store, expenses: store.expenses.filter(item => item.id !== itemId) }).then(() => notify('Расход удален')).catch(() => {}); }; return <><SectionHeader title="Операционные расходы" count={items.length} action="Добавить расход" onAction={() => setModal('expense')} query={query} setQuery={setQuery} /><div className="table-panel"><table><thead><tr><th>Категория</th><th>Дата</th><th>Комментарий</th><th>Сумма</th><th></th></tr></thead><tbody>{items.map(e => <tr key={e.id}><td><strong>{e.category}</strong></td><td>{e.date}</td><td>{e.comment || '—'}</td><td><strong>{money(e.amount, store.settings.currency)}</strong></td><td className="row-actions"><button onClick={() => setModal({ type: 'expense', value: e })}>Изменить</button><button className="delete-btn" onClick={() => remove(e.id)}>×</button></td></tr>)}</tbody></table>{!items.length && <Empty text="Расходов не найдено" />}</div></>; }
function Debts({ store, sales, metrics, persist }) { const [refundForm, setRefundForm] = useState({ reason: '', amount: '', status: 'Ожидается' }); const addRefund = e => { e.preventDefault(); persist({ ...store, refunds: [{ ...refundForm, id: uid(), date: date() }, ...store.refunds] }); setRefundForm({ reason: '', amount: '', status: 'Ожидается' }); }; return <><div className="section-head"><div><p className="eyebrow">КОНТРОЛЬ ДЕНЕГ</p><h2>Дебиторка</h2></div></div><div className="debt-grid"><section className="panel"><div className="panel-heading"><div><h2>Клиенты должны</h2><small className="subtle">{money(metrics.debts, store.settings.currency)} к получению</small></div></div>{sales.filter(s => Number(s.price || 0) > Number(s.paid || 0)).map(s => <div className="list-row" key={s.id}><div className="row-icon red-bg">!</div><div className="row-main"><strong>{s.client || 'Без имени'}</strong><small>{s.purchase?.title || 'Товар'} · {s.paymentStatus}</small></div><strong className="negative">{money(Number(s.price || 0) - Number(s.paid || 0), store.settings.currency)}</strong></div>)}{!sales.some(s => Number(s.price || 0) > Number(s.paid || 0)) && <Empty text="Задолженностей нет" />}</section><section className="panel"><div className="panel-heading"><div><h2>Возвраты от поставщиков</h2><small className="subtle">Ручной учет</small></div></div>{store.refunds.map(r => <div className="list-row" key={r.id}><div className="row-icon orange-bg">↩</div><div className="row-main"><strong>{r.reason}</strong><small>{r.status} · {r.date}</small></div><strong>{money(r.amount, store.settings.currency)}</strong></div>)}<form className="inline-form" onSubmit={addRefund}><input placeholder="Причина возврата" value={refundForm.reason} onChange={e => setRefundForm({ ...refundForm, reason: e.target.value })} required /><input type="number" placeholder="Сумма" value={refundForm.amount} onChange={e => setRefundForm({ ...refundForm, amount: e.target.value })} required /><button className="primary">Добавить</button></form></section></div></>; }
function Warehouse({ store }) { const items = store.purchases.filter(p => p.status === 'На складе'); return <><SectionHeader title="Склад" count={items.length} /><div className="warehouse-total"><span>Заморожено в товарах</span><strong>{money(items.reduce((sum, p) => sum + Number(p.totalCost || 0), 0), store.settings.currency)}</strong></div><div className="table-panel"><table><thead><tr><th>Товар</th><th>Страна</th><th>Площадка</th><th>Себестоимость</th></tr></thead><tbody>{items.map(p => <tr key={p.id}><td><strong>{p.title}</strong></td><td>{p.country}</td><td>{p.platform || '—'}</td><td><strong>{money(p.totalCost, store.settings.currency)}</strong></td></tr>)}</tbody></table>{!items.length && <Empty text="На складе пока пусто" />}</div></>; }
function Taxes({ store, metrics, persist }) { const [amount, setAmount] = useState(''); const paid = store.taxPayments.reduce((sum, item) => sum + Number(item.amount || 0), 0); const addPayment = event => { event.preventDefault(); persist({ ...store, taxPayments: [{ id: uid(), date: date(), amount }, ...store.taxPayments] }); setAmount(''); }; return <><div className="section-head"><div><p className="eyebrow">ОБЯЗАТЕЛЬСТВА</p><h2>Резерв на налоги</h2></div></div><section className="metric-grid"><Metric label="Рекомендуемый резерв" value={metrics.taxes} currency={store.settings.currency} icon="₽" tone="orange" hint={`ставка ${store.settings.taxRate}%`} /><Metric label="Уже уплачено" value={paid} currency={store.settings.currency} icon="✓" tone="green" hint="по истории платежей" /><Metric label="Осталось отложить" value={Math.max(0, metrics.taxes - paid)} currency={store.settings.currency} icon="!" tone="red" hint="к оплате" /></section><div className="content-grid"><section className="panel"><div className="panel-heading"><h2>Отметить уплату</h2></div><form className="tax-form" onSubmit={addPayment}><label>Сумма платежа<input type="number" value={amount} onChange={event => setAmount(event.target.value)} required /></label><button className="primary">Налог уплачен</button></form></section><section className="panel"><div className="panel-heading"><h2>История платежей</h2></div>{store.taxPayments.map(item => <div className="list-row" key={item.id}><div className="row-icon green-bg">✓</div><div className="row-main"><strong>{money(item.amount, store.settings.currency)}</strong><small>{item.date}</small></div></div>)}{!store.taxPayments.length && <Empty text="Платежей пока нет" />}</section></div></>; }
function Reports({ metrics, sales, store, csvExport, pdfExport }) { const [group, setGroup] = useState('product'); const labels = { product: 'товарам', country: 'странам', platform: 'площадкам', month: 'месяцам' }; const rows = Object.entries(sales.reduce((result, sale) => { const key = group === 'product' ? (sale.purchase?.title || 'Без товара') : group === 'country' ? (sale.purchase?.country || 'Не указано') : group === 'platform' ? (sale.purchase?.platform || 'Не указано') : (sale.date || '').slice(0, 7); result[key] = (result[key] || 0) + Number(sale.price || 0) - Number(sale.purchase?.totalCost || 0); return result; }, {})).sort((a, b) => b[1] - a[1]); const max = Math.max(1, ...rows.map(([, value]) => Math.abs(value))); return <><div className="section-head"><div><p className="eyebrow">АНАЛИТИКА</p><h2>Отчёт за период</h2></div><div className="export-actions"><button className="secondary" onClick={csvExport}>↓ Excel / CSV</button><button className="primary" onClick={pdfExport}>↓ PDF</button></div></div><section className="metric-grid report-metrics"><Metric label="Выручка" value={metrics.revenue} currency={store.settings.currency} icon="↗" tone="green" hint={`${sales.length} продаж`} /><Metric label="Себестоимость" value={metrics.cost} currency={store.settings.currency} icon="▧" tone="orange" hint="проданные товары" /><Metric label="Расходы" value={metrics.expenses} currency={store.settings.currency} icon="−" tone="red" hint="операционные" /><Metric label="Чистая прибыль" value={metrics.profit} currency={store.settings.currency} icon="◎" tone="blue" hint={`${metrics.margin.toFixed(1)}% маржинальность`} /></section><div className="content-grid"><section className="panel"><div className="panel-heading"><div><h2>Прибыль по {labels[group]}</h2><select className="compact-select" value={group} onChange={event => setGroup(event.target.value)}><option value="product">По товарам</option><option value="country">По странам</option><option value="platform">По площадкам</option><option value="month">По месяцам</option></select></div></div>{rows.map(([name, value]) => <div className="country-row" key={name}><span>{name}</span><div className="progress"><i style={{ width: `${Math.max(4, Math.abs(value) / max * 100)}%` }}></i></div><strong className={value < 0 ? 'negative' : ''}>{money(value, store.settings.currency)}</strong></div>)}{!rows.length && <Empty text="За выбранный период пока нет продаж" />}</section><section className="panel report-note"><div className="metric-icon blue">i</div><div><h2>Финансовая подсказка</h2><p>Резерв на налоги рассчитан по ставке {store.settings.taxRate}% от каждой продажи. Проверяйте его перед оплатой налога.</p></div></section></div></>; }
function LegacySettings({ store, updateSettings, notify }) { return <div className="settings-grid"><section className="panel settings-card"><div className="panel-heading"><div><p className="eyebrow">ПАРАМЕТРЫ</p><h2>Основные настройки</h2></div></div><label>Основная валюта<select value={store.settings.currency} onChange={e => updateSettings({ currency: e.target.value })}><option>RUB</option><option>KZT</option><option>USD</option><option>EUR</option></select></label><label>Ставка налога, %<input type="number" min="0" max="100" value={store.settings.taxRate} onChange={e => updateSettings({ taxRate: Number(e.target.value) })} /></label><label className="switch-row">Запускать при включении компьютера <input type="checkbox" checked={store.settings.autoLaunch} onChange={e => updateSettings({ autoLaunch: e.target.checked })} /><span className="switch"></span></label><label className="switch-row">Показывать склад <input type="checkbox" checked={store.settings.showWarehouse} onChange={e => updateSettings({ showWarehouse: e.target.checked })} /><span className="switch"></span></label><label>Тема интерфейса<select value={store.settings.theme} onChange={e => updateSettings({ theme: e.target.value })}><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label></section><section className="panel settings-card"><div className="panel-heading"><div><p className="eyebrow">ДАННЫЕ</p><h2>Резервное копирование</h2></div></div><p className="subtle">Сохраняйте копию локального файла с данными. Интернет и внешние базы не используются.</p><button className="secondary full" onClick={() => window.buyerAPI.saveBackup().then(path => path && notify('Резервная копия сохранена'))}>↓ Сохранить копию</button><button className="secondary full" onClick={() => window.buyerAPI.restoreBackup().then(data => data && notify('Данные восстановлены'))}>↥ Восстановить копию</button></section></div>; }

function Modal({ title, children, onClose, onSubmit, submitLabel = 'Сохранить' }) { return <div className="modal-backdrop"><div className="modal"><div className="modal-head"><h2>{title}</h2><button className="close" onClick={onClose}>×</button></div><form onSubmit={onSubmit}>{children}<div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Отмена</button><button className="primary">{submitLabel}</button></div></form></div></div>; }
function Field({ label, children, wide }) { return <label className={wide ? 'wide' : ''}>{label}{children}</label>; }
function LegacyPurchaseModal({ onSave, onClose, settings }) { const [form, setForm] = useState(blankPurchase()); const set = (key, value) => setForm({ ...form, [key]: value }); return <Modal title="Новая закупка" onClose={onClose} onSubmit={e => { e.preventDefault(); onSave({ ...form, totalCost: calcPurchase(form) }); }}><div className="form-grid"><Field label="Дата закупки"><input type="date" value={form.date} onChange={e => set('date', e.target.value)} required /></Field><Field label="Страна закупки"><select value={form.country} onChange={e => set('country', e.target.value)}>{countries.map(x => <option key={x}>{x}</option>)}</select></Field><Field label="Площадка"><input placeholder="Mercari, Amazon" value={form.platform} onChange={e => set('platform', e.target.value)} /></Field><Field label="Название товара" wide><input value={form.title} onChange={e => set('title', e.target.value)} required /></Field><Field label="Категория"><input value={form.category} onChange={e => set('category', e.target.value)} /></Field><Field label="Ссылка"><input type="url" placeholder="https://..." value={form.link} onChange={e => set('link', e.target.value)} /></Field><Field label="Цена товара"><input type="number" step="0.01" value={form.price} onChange={e => set('price', e.target.value)} required /></Field><Field label="Валюта"><select value={form.currency} onChange={e => set('currency', e.target.value)}><option>USD</option><option>JPY</option><option>KRW</option><option>EUR</option></select></Field><Field label="Курс к {settings.currency}"><input type="number" step="0.0001" value={form.rate} onChange={e => set('rate', e.target.value)} required /></Field><Field label="Внутренняя доставка"><input type="number" value={form.internalDelivery} onChange={e => set('internalDelivery', e.target.value)} /></Field><Field label="Международная доставка"><input type="number" value={form.internationalDelivery} onChange={e => set('internationalDelivery', e.target.value)} /></Field><Field label="Пошлина / НДС"><input type="number" value={form.customs} onChange={e => set('customs', e.target.value)} /></Field><Field label="Комиссия агента"><input type="number" value={form.agentFee} onChange={e => set('agentFee', e.target.value)} /></Field><Field label="Статус"><select value={form.status} onChange={e => set('status', e.target.value)}>{purchaseStatuses.map(x => <option key={x}>{x}</option>)}</select></Field></div><div className="calculated">Итоговая себестоимость <strong>{money(calcPurchase(form), settings.currency)}</strong></div></Modal>; }
function SaleModal({ onSave, onClose, purchases, currency, value }) { const [form, setForm] = useState(() => ({ ...blankSale(), ...(value || {}) })); const set = (key, nextValue) => setForm(current => ({ ...current, [key]: nextValue })); return <Modal title={value ? 'Изменить продажу' : 'Новая продажа'} onClose={onClose} onSubmit={e => { e.preventDefault(); onSave(form, value); }}><div className="form-grid"><Field label="Дата продажи"><input type="date" value={form.date} onChange={e => set('date', e.target.value)} required /></Field><Field label="Товар" wide><select value={form.purchaseId} onChange={e => set('purchaseId', e.target.value)} required><option value="">Выберите товар</option>{purchases.map(p => <option value={p.id} key={p.id}>{p.title} · {money(p.totalCost, currency)}</option>)}</select></Field><Field label="Клиент"><input value={form.client} onChange={e => set('client', e.target.value)} placeholder="Имя или ID" /></Field><Field label="Цена продажи"><input type="number" min="0" step="0.01" value={form.price} onChange={e => set('price', e.target.value)} required /></Field><Field label="Статус оплаты"><select value={form.paymentStatus} onChange={e => set('paymentStatus', e.target.value)}>{paymentStatuses.map(x => <option key={x}>{x}</option>)}</select></Field><Field label="Получено фактически"><input type="number" min="0" step="0.01" value={form.paid} onChange={e => set('paid', e.target.value)} required /></Field></div></Modal>; }
function ExpenseModal({ onSave, onClose, value }) { const [form, setForm] = useState(() => ({ date: date(), category: expenseCategories[0], amount: '', comment: '', ...(value || {}) })); return <Modal title={value ? 'Изменить расход' : 'Операционный расход'} onClose={onClose} onSubmit={e => { e.preventDefault(); onSave(form, value); }}><div className="form-grid"><Field label="Дата"><input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} required /></Field><Field label="Категория"><select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>{expenseCategories.map(x => <option key={x}>{x}</option>)}</select></Field><Field label="Сумма"><input type="number" min="0" step="0.01" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} required /></Field><Field label="Комментарий" wide><input value={form.comment} onChange={e => setForm({ ...form, comment: e.target.value })} /></Field></div></Modal>; }

function Sales({ sales, store, setModal, persist, notify, query, setQuery }) {
  const items = sales.filter(sale => !query || `${sale.purchase?.title} ${sale.client} ${sale.purchase?.link || ''}`.toLowerCase().includes(query.toLowerCase()));
  const remove = saleId => {
    const sale = store.sales.find(item => item.id === saleId);
    const purchases = store.purchases.map(purchase => purchase.id === sale?.purchaseId ? { ...purchase, status: 'На складе' } : purchase);
    persist({ ...store, sales: store.sales.filter(item => item.id !== saleId), purchases });
    notify('Сделка удалена');
  };
  return <>
    <SectionHeader title="Сделки под заказ" count={items.length} action="Новая сделка" onAction={() => setModal('sale')} query={query} setQuery={setQuery} />
    <div className="table-panel"><table><thead><tr><th>Товар</th><th>Дата</th><th>Продажа</th><th>Выкуп / доставка</th><th>Курс</th><th>Налог</th><th>Чистая прибыль</th><th></th></tr></thead>
    <tbody>{items.map(sale => {
      const row = dealMetrics(sale, sale.purchase, store.settings.taxRate);
      return <tr key={sale.id}>
        <td><strong>{sale.purchase?.title || '—'}</strong><small>{sale.client || 'Без клиента'}{sale.purchase?.link ? <> · <a href={sale.purchase.link} target="_blank" rel="noreferrer">сайт</a></> : null}</small></td>
        <td>{sale.date}</td>
        <td><strong>{money(sale.price, store.settings.currency)}</strong><small>получено {money(sale.paid, store.settings.currency)}</small></td>
        <td>{sale.purchase?.price || 0} {sale.purchase?.currency || 'USD'}<small>доставка {sale.purchase?.internationalDelivery || 0} {sale.purchase?.currency || 'USD'}</small></td>
        <td>{row.rate || '—'}</td>
        <td>{money(row.tax, store.settings.currency)}<small>{row.taxRate || store.settings.taxRate}%</small></td>
        <td className={row.profit >= 0 ? 'positive' : 'negative'}><strong>{money(row.profit, store.settings.currency)}</strong></td>
        <td className="row-actions"><button onClick={() => setModal({ type: 'sale', value: sale })}>Изменить</button><button className="delete-btn" onClick={() => remove(sale.id)}>×</button></td>
      </tr>;
    })}</tbody></table>{!items.length && <Empty text="Сделок не найдено" />}</div>
  </>;
}

function Settings({ store, updateSettings, notify, restoreBackup, liveRates, refreshKaspiRate }) { return <div className="settings-grid"><section className="panel settings-card"><div className="panel-heading"><div><p className="eyebrow">ПАРАМЕТРЫ</p><h2>Основные настройки</h2></div></div><label>Основная валюта<select value={store.settings.currency} onChange={event => updateSettings({ currency: event.target.value })}><option>KZT</option><option>RUB</option><option>USD</option><option>EUR</option></select></label><div className="exchange-rates"><strong>Курс Каспи к {store.settings.currency}</strong><p className="subtle">{liveRates?.USD ? `Сейчас ${Number(liveRates.USD).toFixed(2)} ₸ за $1${liveRates.source ? ` · ${liveRates.source}` : ''}` : 'Курс подтянется автоматически. Если Каспи снял больше — поправьте в сделке.'}</p><label>USD<input type="number" min="0" step="0.0001" value={store.settings.exchangeRates?.USD || ''} onChange={event => updateSettings({ exchangeRates: { ...store.settings.exchangeRates, USD: event.target.value } })} placeholder="Например, 471" /></label><label>EUR<input type="number" min="0" step="0.0001" value={store.settings.exchangeRates?.EUR || ''} onChange={event => updateSettings({ exchangeRates: { ...store.settings.exchangeRates, EUR: event.target.value } })} /></label><label>JPY<input type="number" min="0" step="0.0001" value={store.settings.exchangeRates?.JPY || ''} onChange={event => updateSettings({ exchangeRates: { ...store.settings.exchangeRates, JPY: event.target.value } })} /></label><label>KRW<input type="number" min="0" step="0.0001" value={store.settings.exchangeRates?.KRW || ''} onChange={event => updateSettings({ exchangeRates: { ...store.settings.exchangeRates, KRW: event.target.value } })} /></label><button type="button" className="secondary full" onClick={() => refreshKaspiRate(false)}>Обновить курс Каспи</button></div><div className="exchange-rates"><strong>Налог и комиссия</strong><small className="subtle">По вашему сценарию: 1% платёжная система + 3% налог = 4% итого</small><label>Комиссия Pay, %<input type="number" min="0" max="100" step="0.1" value={store.settings.paymentFeeRate ?? 1} onChange={event => updateSettings({ paymentFeeRate: Number(event.target.value) })} /></label><label>Налог, %<input type="number" min="0" max="100" step="0.1" value={store.settings.taxRate ?? 3} onChange={event => updateSettings({ taxRate: Number(event.target.value) })} /></label><div className="subtle">Итого: <strong>{Number((store.settings.paymentFeeRate ?? 1) + (store.settings.taxRate ?? 3)).toFixed(1)}%</strong></div></div><label className="switch-row">Запускать при включении компьютера <input type="checkbox" checked={store.settings.autoLaunch} onChange={event => updateSettings({ autoLaunch: event.target.checked })} /><span className="switch"></span></label><label className="switch-row">Показывать склад <input type="checkbox" checked={store.settings.showWarehouse} onChange={event => updateSettings({ showWarehouse: event.target.checked })} /><span className="switch"></span></label><label>Тема интерфейса<select value={store.settings.theme} onChange={event => updateSettings({ theme: event.target.value })}><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label></section><section className="panel settings-card"><div className="panel-heading"><div><p className="eyebrow">ДАННЫЕ</p><h2>Резервное копирование</h2></div></div><p className="subtle">Сохраняйте копию локального файла с данными.</p><button className="secondary full" onClick={() => window.buyerAPI.saveBackup().then(path => path && notify('Резервная копия сохранена'))}>↓ Сохранить копию</button><button className="secondary full" onClick={restoreBackup}>↥ Восстановить копию</button></section></div>; }

function LegacyPurchaseModalV2({ onSave, onClose, settings, value }) {
  const [form, setForm] = useState(() => ({ ...blankPurchase(), ...(value || {}) }));
  const set = (key, nextValue) => setForm(current => ({ ...current, [key]: nextValue }));
  useEffect(() => { setForm(current => ({ ...current, internalDeliveryRate: settings.currency === 'KZT' ? '1' : (current.internalDeliveryRate || settings.exchangeRates?.KZT || ''), internationalDeliveryRate: current.rate || current.internationalDeliveryRate || '' })); }, [settings.currency, settings.exchangeRates?.KZT]);
  return <Modal title={value ? 'Изменить закупку' : 'Новая закупка'} onClose={onClose} onSubmit={event => { event.preventDefault(); onSave({ ...form, totalCost: calcPurchase(form) }, value); }}><div className="form-grid"><Field label="Дата закупки"><input type="date" value={form.date} onChange={event => set('date', event.target.value)} required /></Field><Field label="Страна закупки"><select value={form.country} onChange={event => set('country', event.target.value)}>{countries.map(country => <option key={country}>{country}</option>)}</select></Field><Field label="Площадка"><input value={form.platform} onChange={event => set('platform', event.target.value)} placeholder="Mercari, Amazon" /></Field><Field label="Название товара" wide><input value={form.title} onChange={event => set('title', event.target.value)} required /></Field><Field label="Категория"><input value={form.category} onChange={event => set('category', event.target.value)} /></Field><Field label="Ссылка"><input type="url" value={form.link} onChange={event => set('link', event.target.value)} placeholder="https://..." /></Field><Field label="Цена товара"><input type="number" step="0.01" value={form.price} onChange={event => set('price', event.target.value)} required /></Field><Field label="Валюта товара"><select value={form.currency} onChange={event => set('currency', event.target.value)}><option>USD</option><option>JPY</option><option>KRW</option><option>EUR</option></select></Field><Field label={`Курс товара к ${settings.currency}`}><input type="number" min="0" step="0.0001" value={form.rate} onChange={event => set('rate', event.target.value)} required /></Field><Field label="Внутренняя доставка (KZT)"><input type="number" min="0" step="0.01" value={form.internalDelivery} onChange={event => set('internalDelivery', event.target.value)} /></Field><Field label={`Курс KZT к ${settings.currency}`}><input type="number" min="0" step="0.0001" value={form.internalDeliveryRate} onChange={event => set('internalDeliveryRate', event.target.value)} required={Boolean(form.internalDelivery)} /></Field><Field label="Международная доставка (USD)"><input type="number" min="0" step="0.01" value={form.internationalDelivery} onChange={event => set('internationalDelivery', event.target.value)} /></Field><Field label={`Курс USD к ${settings.currency}`}><input type="number" min="0" step="0.0001" value={form.internationalDeliveryRate} onChange={event => set('internationalDeliveryRate', event.target.value)} required={Boolean(form.internationalDelivery)} /></Field><Field label="Пошлина / НДС"><input type="number" min="0" value={form.customs} onChange={event => set('customs', event.target.value)} /></Field><Field label="Комиссия агента"><input type="number" min="0" value={form.agentFee} onChange={event => set('agentFee', event.target.value)} /></Field><Field label="Статус"><select value={form.status} onChange={event => set('status', event.target.value)}>{purchaseStatuses.map(status => <option key={status}>{status}</option>)}</select></Field></div><div className="calculated">Итоговая себестоимость <strong>{money(calcPurchase(form), settings.currency)}</strong></div></Modal>;
}

function DealModal({ onSave, onClose, purchases, settings, liveRates, value, refreshKaspiRate }) {
  const [form, setForm] = useState(() => ({
    ...blankSale(settings),
    ...(value || {}),
    rate: value?.rate ?? getCurrencyRate(value?.buyCurrency || 'USD', settings, liveRates),
    buyPrice: value?.buyPrice || value?.purchase?.price || '',
    buyCurrency: value?.buyCurrency || value?.purchase?.currency || 'USD',
    delivery: value?.delivery || value?.purchase?.internationalDelivery || '',
    title: value?.title || value?.purchase?.title || '',
    link: value?.link || value?.purchase?.link || '',
    country: value?.country || value?.purchase?.country || 'США',
    platform: value?.platform || value?.purchase?.platform || '',
    category: value?.category || value?.purchase?.category || 'Без категории'
  }));
  const set = (key, nextValue) => setForm(current => ({ ...current, [key]: nextValue }));
  useEffect(() => {
    const nextRate = getCurrencyRate(form.buyCurrency || 'USD', settings, liveRates);
    if (!value && (!form.rate || form.rate === '' || Number(form.rate) <= 0 || String(form.buyCurrency) !== (value?.buyCurrency || form.buyCurrency))) {
      set('rate', nextRate);
    }
  }, [form.buyCurrency, settings.exchangeRates, liveRates, value]);
  const calculated = calcDeal(form, combinedTaxRate(settings));
  const currentRateLabel = Number(form.rate || 0) ? `${Number(form.rate).toFixed(2)} ₸` : 'Курс не указан';
  return <Modal title={value ? 'Изменить сделку' : 'Новая сделка'} onClose={onClose} onSubmit={event => { event.preventDefault(); onSave(form, value); }}>
    <div className="form-grid">
      <Field label="Дата сделки"><input type="date" value={form.date} onChange={event => set('date', event.target.value)} required /></Field>
      <Field label="Товар" wide>
        <select value={form.purchaseId} onChange={event => set('purchaseId', event.target.value)}>
          <option value="">Новый товар</option>
          {purchases.map(purchase => <option value={purchase.id} key={purchase.id}>{purchase.title} · {money(purchase.totalCost, settings.currency)}</option>)}
        </select>
      </Field>
      <Field label="Название товара" wide><input value={form.title} onChange={event => set('title', event.target.value)} placeholder="Часы, сумка, платье..." /></Field>
      <Field label="Ссылка"><input type="url" value={form.link} onChange={event => set('link', event.target.value)} placeholder="https://..." /></Field>
      <Field label="Клиент"><input value={form.client} onChange={event => set('client', event.target.value)} placeholder="Имя клиента" /></Field>
      <Field label="Цена продажи (KZT)"><input type="number" min="0" step="0.01" value={form.price} onChange={event => set('price', event.target.value)} required /></Field>
      <Field label="Получено"><input type="number" min="0" step="0.01" value={form.paid} onChange={event => set('paid', event.target.value)} required /></Field>
      <Field label="Статус оплаты"><select value={form.paymentStatus} onChange={event => set('paymentStatus', event.target.value)}>{paymentStatuses.map(status => <option key={status}>{status}</option>)}</select></Field>
      <Field label="Закупка / цена товара"><input type="number" min="0" step="0.01" value={form.buyPrice} onChange={event => set('buyPrice', event.target.value)} required /></Field>
      <Field label="Валюта закупки"><select value={form.buyCurrency} onChange={event => { const nextCurrency = event.target.value; set('buyCurrency', nextCurrency); set('rate', getCurrencyRate(nextCurrency, settings, liveRates)); }}><option>USD</option><option>JPY</option><option>KRW</option><option>EUR</option></select></Field>
      <Field label="Доставка"><input type="number" min="0" step="0.01" value={form.delivery} onChange={event => set('delivery', event.target.value)} /></Field>
      <Field label={`Курс ${form.buyCurrency} → ${settings.currency}`}><input type="number" min="0" step="0.0001" value={form.rate} onChange={event => set('rate', event.target.value)} required /></Field>
      <Field label="Страна"><select value={form.country} onChange={event => set('country', event.target.value)}>{countries.map(country => <option key={country}>{country}</option>)}</select></Field>
      <Field label="Площадка"><input value={form.platform} onChange={event => set('platform', event.target.value)} placeholder="Instagram, Amazon" /></Field>
      <Field label="Категория"><input value={form.category} onChange={event => set('category', event.target.value)} /></Field>
    </div>
    <div className="calculated">
      <div><small>Курс сейчас</small><strong>{currentRateLabel}</strong></div>
      <div><small>Себестоимость</small><strong>{money(calculated.cost, settings.currency)}</strong></div>
      <div><small>Налог {combinedTaxRate(settings)}%</small><strong>{money(calculated.tax, settings.currency)}</strong></div>
      <div><small>Чистая прибыль</small><strong className={calculated.profit >= 0 ? 'positive' : 'negative'}>{money(calculated.profit, settings.currency)}</strong></div>
    </div>
    <div className="modal-inline-actions">
      <button type="button" className="secondary" onClick={() => { if (refreshKaspiRate) refreshKaspiRate(true).catch(() => {}); }}>Авто-курс Каспи</button>
    </div>
  </Modal>;
}

function PurchaseModal({ onSave, onClose, settings, value, liveRates }) {
  const [form, setForm] = useState(() => ({ ...blankPurchase(settings), ...(value || {}), rate: value?.rate ?? getCurrencyRate(value?.currency || 'USD', settings, liveRates) }));
  const set = (key, nextValue) => setForm(current => ({ ...current, [key]: nextValue }));
  useEffect(() => {
    const nextRate = getCurrencyRate(form.currency || 'USD', settings, liveRates);
    if (!value && (!form.rate || form.rate === '' || Number(form.rate) <= 0)) {
      set('rate', nextRate);
    }
  }, [form.currency, settings.exchangeRates, liveRates, value]);
  const internalRate = settings.currency === 'KZT' ? 1 : (settings.exchangeRates?.KZT || '');
  return <Modal title={value ? 'Изменить закупку' : 'Новая закупка'} onClose={onClose} onSubmit={event => { event.preventDefault(); onSave({ ...form, internalDeliveryRate: internalRate }, value); }}><div className="form-grid">
    <Field label="Дата закупки"><input type="date" value={form.date} onChange={event => set('date', event.target.value)} required /></Field>
    <Field label="Страна закупки"><select value={form.country} onChange={event => set('country', event.target.value)}>{countries.map(country => <option key={country}>{country}</option>)}</select></Field>
    <Field label="Площадка"><input value={form.platform} onChange={event => set('platform', event.target.value)} placeholder="Mercari, Amazon" /></Field>
    <Field label="Название товара" wide><input value={form.title} onChange={event => set('title', event.target.value)} required /></Field>
    <Field label="Категория"><input value={form.category} onChange={event => set('category', event.target.value)} /></Field>
    <Field label="Ссылка"><input type="url" value={form.link} onChange={event => set('link', event.target.value)} placeholder="https://..." /></Field>
    <Field label="Цена товара"><input type="number" min="0" step="0.01" value={form.price} onChange={event => set('price', event.target.value)} required /></Field>
    <Field label="Валюта товара"><select value={form.currency} onChange={event => { const nextCurrency = event.target.value; set('currency', nextCurrency); set('rate', getCurrencyRate(nextCurrency, settings, liveRates)); }}><option>USD</option><option>JPY</option><option>KRW</option><option>EUR</option></select></Field>
    <Field label={`Единый курс ${form.currency} к ${settings.currency}`}><input type="number" min="0" step="0.0001" value={form.rate} onChange={event => set('rate', event.target.value)} required /></Field>
    <Field label="Внутренняя доставка (тенге)"><input type="number" min="0" step="0.01" value={form.internalDelivery} onChange={event => set('internalDelivery', event.target.value)} /></Field>
    <Field label={`Международная доставка (${form.currency})`}><input type="number" min="0" step="0.01" value={form.internationalDelivery} onChange={event => set('internationalDelivery', event.target.value)} /></Field>
    <Field label="Пошлина / НДС"><input type="number" min="0" step="0.01" value={form.customs} onChange={event => set('customs', event.target.value)} /></Field>
    <Field label="Комиссия агента"><input type="number" min="0" step="0.01" value={form.agentFee} onChange={event => set('agentFee', event.target.value)} /></Field>
    <Field label="Статус"><select value={form.status} onChange={event => set('status', event.target.value)}>{purchaseStatuses.map(status => <option key={status}>{status}</option>)}</select></Field>
  </div></Modal>;
}

createRoot(document.getElementById('root')).render(<App />);
