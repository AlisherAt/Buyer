import React, { useEffect, useState } from 'react';
import { supabase } from './supabase';

export default function AdminSubscriptions({ notify }) {
  const [email, setEmail] = useState('');
  const [profiles, setProfiles] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [days, setDays] = useState('30');
  const [subscriptions, setSubscriptions] = useState({});
  const loadUsers = async () => {
    const [{ data: profileData, error: profileError }, { data: subscriptionData, error: subscriptionError }] = await Promise.all([
      supabase.from('profiles').select('user_id,email,role,created_at').order('created_at', { ascending: false }),
      supabase.from('subscriptions').select('user_id,status,plan,current_period_end,is_permanent,amount,currency')
    ]);
    if (profileError || subscriptionError) return notify('Не удалось загрузить пользователей. Проверьте SQL и права администратора.');
    const nextSubscriptions = Object.fromEntries((subscriptionData || []).map(item => [item.user_id, item]));
    setSubscriptions(nextSubscriptions);
    setProfiles(profileData || []);
  };
  useEffect(() => {
    loadUsers();
    const timer = setInterval(loadUsers, 5000);
    return () => clearInterval(timer);
  }, []);
  const search = event => { event.preventDefault(); setProfiles(current => current.filter(item => item.email.toLowerCase().includes(email.toLowerCase()))); };
  const save = async (permanent = false, extend = false) => {
    if (!selectedUser) return notify('Выберите пользователя');
    const current = subscriptions[selectedUser.user_id];
    const currentEnd = current?.current_period_end ? new Date(current.current_period_end).getTime() : 0;
    const start = extend && current?.status === 'active' && currentEnd > Date.now() ? currentEnd : Date.now();
    const end = permanent ? null : new Date(start + Number(days || 0) * 86400000).toISOString();
    const { error } = await supabase.from('subscriptions').upsert({ user_id: selectedUser.user_id, status: 'active', plan: permanent ? 'permanent' : 'manual', amount: 1000, currency: 'KZT', current_period_end: end, is_permanent: permanent, updated_at: new Date().toISOString() });
    if (error) return notify('Не удалось сохранить подписку. Проверьте SQL и права администратора.');
    notify(permanent ? 'Выдан бессрочный доступ' : extend ? 'Подписка продлена' : 'Доступ выдан');
    await loadUsers();
  };
  const disable = async () => {
    if (!selectedUser) return;
    const { error } = await supabase.from('subscriptions').upsert({ user_id: selectedUser.user_id, status: 'inactive', plan: 'manual', amount: 1000, currency: 'KZT', current_period_end: new Date().toISOString(), is_permanent: false, updated_at: new Date().toISOString() });
    if (error) return notify('Не удалось отключить доступ');
    notify('Доступ отключён');
    await loadUsers();
  };
  const status = item => {
    const subscription = subscriptions[item.user_id];
    if (!subscription || subscription.status !== 'active') return 'Нет доступа';
    if (subscription.is_permanent) return 'Бессрочно';
    const end = new Date(subscription.current_period_end);
    return end > new Date() ? `До ${end.toLocaleDateString('ru-RU')}` : 'Истёк';
  };
  const filteredProfiles = profiles.filter(item => item.email.toLowerCase().includes(email.toLowerCase()));
  return <section className="panel settings-card admin-subscriptions"><div className="panel-heading"><div><p className="eyebrow">АДМИНИСТРАТОР</p><h2>Пользователи и подписки</h2></div><button className="secondary" onClick={loadUsers}>Обновить</button></div><p className="subtle">Новые аккаунты появляются автоматически. Список обновляется каждые 5 секунд.</p><form className="inline-form" onSubmit={search}><input type="search" placeholder="Поиск по email" value={email} onChange={event => setEmail(event.target.value)} /><button className="secondary">Найти</button></form><div className="admin-users">{filteredProfiles.map(item => <button className={`admin-user ${selectedUser?.user_id === item.user_id ? 'selected' : ''}`} key={item.user_id} onClick={() => setSelectedUser(item)}><span>{item.email}</span><small>{item.role === 'admin' ? 'Администратор' : 'Пользователь'} · {status(item)}</small></button>)}</div>{selectedUser && <div className="admin-access-form"><strong>{selectedUser.email}</strong><label>Добавить дней<input type="number" min="1" value={days} onChange={event => setDays(event.target.value)} /></label><div className="admin-actions"><button className="primary" onClick={() => save(false, false)}>Выдать доступ</button><button className="secondary" onClick={() => save(false, true)}>Продлить</button><button className="secondary" onClick={() => save(true, false)}>Сделать бессрочной</button><button className="delete-btn" onClick={disable}>Отключить</button></div></div>}</section>;
}
