import React, { useState } from 'react';
import { supabase } from './supabase';

export default function AdminSubscriptions({ notify }) {
  const [email, setEmail] = useState('');
  const [profiles, setProfiles] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [days, setDays] = useState('30');
  const [permanent, setPermanent] = useState(false);
  const search = async event => {
    event.preventDefault();
    const { data, error } = await supabase.from('profiles').select('user_id,email').ilike('email', `%${email}%`).limit(10);
    if (error) return notify('Не удалось найти пользователей');
    setProfiles(data || []);
  };
  const save = async event => {
    event.preventDefault();
    if (!selectedUser) return notify('Выберите пользователя');
    const end = permanent ? null : new Date(Date.now() + Number(days || 0) * 86400000).toISOString();
    const { error } = await supabase.from('subscriptions').upsert({ user_id: selectedUser.user_id, status: 'active', plan: permanent ? 'permanent' : 'manual', amount: 1000, currency: 'KZT', current_period_end: end, is_permanent: permanent, updated_at: new Date().toISOString() });
    notify(error ? 'Не удалось сохранить подписку. Проверьте SQL и права администратора.' : 'Подписка выдана');
  };
  return <section className="panel settings-card admin-subscriptions"><div className="panel-heading"><div><p className="eyebrow">АДМИНИСТРАТОР</p><h2>Управление доступом</h2></div></div><p className="subtle">Найдите пользователя по email и выдайте доступ на срок или бессрочно.</p><form className="inline-form" onSubmit={search}><input type="email" placeholder="Email пользователя" value={email} onChange={event => setEmail(event.target.value)} required /><button className="secondary">Найти</button></form>{profiles.map(item => <button className={`admin-user ${selectedUser?.user_id === item.user_id ? 'selected' : ''}`} key={item.user_id} onClick={() => setSelectedUser(item)}>{item.email}</button>)}{selectedUser && <form className="admin-access-form" onSubmit={save}><strong>{selectedUser.email}</strong><label className="switch-row">Бессрочный доступ <input type="checkbox" checked={permanent} onChange={event => setPermanent(event.target.checked)} /><span className="switch"></span></label>{!permanent && <label>Дней доступа<input type="number" min="1" value={days} onChange={event => setDays(event.target.value)} required /></label>}<button className="primary">Выдать доступ</button></form>}</section>;
}
