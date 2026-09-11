import React, { useEffect, useState } from "react";
import { supabase } from "./supabase";

export default function AdminSubscriptions({ notify }) {
  const [email, setEmail] = useState("");
  const [profiles, setProfiles] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [days, setDays] = useState("30");
  const [subscriptions, setSubscriptions] = useState({});
  const [logs, setLogs] = useState([]);
  const [history, setHistory] = useState([]);
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("newest");
  const [busy, setBusy] = useState(false);
  const loadUsers = async () => {
    const { data: profileData, error: profileError } =
      await supabase.rpc("admin_list_users");
    if (profileError)
      return notify(
        "Не удалось загрузить пользователей. Выполните supabase-schema.sql и проверьте роль admin.",
      );
    const { data: subscriptionData, error: subscriptionError } = await supabase
      .from("subscriptions")
      .select(
        "user_id,status,plan,current_period_end,is_permanent,amount,currency",
      );
    if (subscriptionError)
      notify(
        "Пользователи загружены, но подписки пока недоступны. Выполните supabase-schema.sql.",
      );
    const nextSubscriptions = Object.fromEntries(
      (subscriptionData || []).map((item) => [item.user_id, item]),
    );
    setSubscriptions(nextSubscriptions);
    setProfiles(profileData || []);
    const { data: logData } = await supabase
      .from("audit_logs")
      .select("action,details,created_at")
      .order("created_at", { ascending: false })
      .limit(8);
    setLogs(logData || []);
    const { data: historyData } = await supabase
      .from("subscription_history")
      .select("user_id,status,current_period_end,is_permanent,created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    setHistory(historyData || []);
  };
  useEffect(() => {
    loadUsers();
    const timer = setInterval(loadUsers, 5000);
    return () => clearInterval(timer);
  }, []);
  const search = (event) => {
    event.preventDefault();
    setProfiles((current) =>
      current.filter((item) =>
        item.email.toLowerCase().includes(email.toLowerCase()),
      ),
    );
  };
  const save = async (permanent = false, extend = false) => {
    if (!selectedUser) return notify("Выберите пользователя");
    const amountOfDays = Number(days);
    if (!permanent && (!Number.isInteger(amountOfDays) || amountOfDays < 1))
      return notify("Укажите количество дней больше нуля");
    setBusy(true);
    const current = subscriptions[selectedUser.user_id];
    const currentEnd = current?.current_period_end
      ? new Date(current.current_period_end).getTime()
      : 0;
    const start =
      extend && current?.status === "active" && currentEnd > Date.now()
        ? currentEnd
        : Date.now();
    const end = permanent
      ? null
      : new Date(start + amountOfDays * 86400000).toISOString();
    const { error } = await supabase
      .from("subscriptions")
      .upsert({
        user_id: selectedUser.user_id,
        status: "active",
        plan: permanent ? "permanent" : "manual",
        amount: 15000,
        currency: "KZT",
        current_period_end: end,
        is_permanent: permanent,
        updated_at: new Date().toISOString(),
      });
    if (error) {
      setBusy(false);
      return notify(`Не удалось сохранить подписку: ${error.message}`);
    }
    await writeAudit(
      permanent
        ? "permanent_access"
        : extend
          ? "extend_access"
          : "grant_access",
      selectedUser.user_id,
      { days: permanent ? null : amountOfDays },
    );
    notify(
      permanent
        ? "Выдан бессрочный доступ"
        : extend
          ? `Подписка продлена на ${amountOfDays} дней`
          : `Доступ выдан на ${amountOfDays} дней`,
    );
    await loadUsers();
    setBusy(false);
  };
  const disable = async () => {
    if (!selectedUser) return;
    if (
      !window.confirm(
        `Отключить доступ для ${selectedUser.email}? Действие будет записано в журнал.`,
      )
    )
      return;
    setBusy(true);
    const { error } = await supabase
      .from("subscriptions")
      .upsert({
        user_id: selectedUser.user_id,
        status: "inactive",
        plan: "manual",
        amount: 15000,
        currency: "KZT",
        current_period_end: new Date().toISOString(),
        is_permanent: false,
        updated_at: new Date().toISOString(),
      });
    if (error) {
      setBusy(false);
      return notify(`Не удалось отключить доступ: ${error.message}`);
    }
    await writeAudit("revoke_access", selectedUser.user_id, {});
    notify("Доступ отключён");
    await loadUsers();
    setBusy(false);
  };
  const writeAudit = async (action, targetUserId, details) => {
    const { data } = await supabase.auth.getUser();
    if (data.user)
      await supabase
        .from("audit_logs")
        .insert({
          admin_user_id: data.user.id,
          target_user_id: targetUserId,
          action,
          details,
        });
  };
  const status = (item) => {
    const subscription = subscriptions[item.user_id];
    if (!subscription || subscription.status !== "active") return "Нет доступа";
    if (subscription.is_permanent) return "Бессрочно";
    const end = new Date(subscription.current_period_end);
    return end > new Date() ? `До ${end.toLocaleDateString("ru-RU")}` : "Истёк";
  };
  const filteredProfiles = profiles
    .filter((item) => {
      const active =
        subscriptions[item.user_id]?.status === "active" &&
        (subscriptions[item.user_id]?.is_permanent ||
          new Date(subscriptions[item.user_id]?.current_period_end) >
            new Date());
      return (
        item.email.toLowerCase().includes(email.toLowerCase()) &&
        (filter === "all" || (filter === "active" ? active : !active))
      );
    })
    .sort((a, b) =>
      sort === "newest"
        ? new Date(b.created_at) - new Date(a.created_at)
        : sort === "oldest"
          ? new Date(a.created_at) - new Date(b.created_at)
          : a.email.localeCompare(b.email),
    );
  const activeCount = profiles.filter((item) => {
    const itemSubscription = subscriptions[item.user_id];
    return (
      itemSubscription?.status === "active" &&
      (itemSubscription.is_permanent ||
        new Date(itemSubscription.current_period_end) > new Date())
    );
  }).length;
  return (
    <section className="panel settings-card admin-subscriptions">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">АДМИНИСТРАТОР</p>
          <h2>Пользователи и подписки</h2>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={loadUsers}
          disabled={busy}
        >
          Обновить
        </button>
      </div>
      <p className="subtle">
        Выдача и отключение меняют только доступ к приложению. Данные
        пользователя сохраняются.
      </p>
      <div className="admin-stats">
        <span>
          Всего аккаунтов <strong>{profiles.length}</strong>
        </span>
        <span>
          Активных доступов <strong>{activeCount}</strong>
        </span>
        <span>
          Без доступа <strong>{profiles.length - activeCount}</strong>
        </span>
      </div>
      <form className="inline-form" onSubmit={search}>
        <input
          type="search"
          placeholder="Поиск по email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button className="secondary">Найти</button>
      </form>
      <div className="admin-filters">
        <select value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">Все статусы</option>
          <option value="active">Активные</option>
          <option value="blocked">Заблокированные</option>
        </select>
        <select value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="newest">Сначала новые</option>
          <option value="oldest">Сначала ранние</option>
          <option value="email">По email</option>
        </select>
      </div>
      <div className="admin-users">
        {filteredProfiles.map((item) => (
          <button
            type="button"
            className={`admin-user ${selectedUser?.user_id === item.user_id ? "selected" : ""}`}
            key={item.user_id}
            onClick={() => setSelectedUser(item)}
          >
            <span>{item.email}<small>Регистрация: {new Date(item.created_at).toLocaleDateString("ru-RU")}</small></span>
            <small>
              {item.role === "admin" ? "Администратор" : "Пользователь"} ·{" "}
              {status(item)}
            </small>
          </button>
        ))}
      </div>
      {selectedUser && (
        <div className="admin-access-form">
          <strong>{selectedUser.email}</strong>
          <label>
            Добавить дней
            <input
              type="number"
              min="1"
              value={days}
              onChange={(event) => setDays(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="admin-actions">
            <button
              type="button"
              className="primary"
              onClick={() => save(false, false)}
              disabled={busy}
            >
              Выдать доступ
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => save(false, true)}
              disabled={busy}
            >
              Продлить
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => save(true, false)}
              disabled={busy}
            >
              Сделать бессрочной
            </button>
            <button
              type="button"
              className="delete-btn"
              onClick={disable}
              disabled={busy}
            >
              Отключить доступ
            </button>
          </div>
          <div className="admin-log">
            <strong>История продлений</strong>
            {history.filter((item) => item.user_id === selectedUser.user_id).slice(0, 6).map((item, index) => <small key={`${item.created_at}-${index}`}>{new Date(item.created_at).toLocaleString("ru-RU")} · {item.is_permanent ? "бессрочно" : `до ${new Date(item.current_period_end).toLocaleDateString("ru-RU")}`}</small>)}
          </div>
        </div>
      )}
      <div className="admin-log">
        <strong>Последние действия</strong>
        {logs.map((log, index) => (
          <small key={`${log.created_at}-${index}`}>
            {log.action} · {new Date(log.created_at).toLocaleString("ru-RU")}
          </small>
        ))}
      </div>
    </section>
  );
}
