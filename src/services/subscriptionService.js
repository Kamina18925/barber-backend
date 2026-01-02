import pool from '../db/connection.js';

const normalizeRole = (role) => String(role || '').toLowerCase();

const parsePgTimestamp = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : d;
};

export const computeOwnerUsageCounts = async (client, ownerId) => {
  const shopsRes = await client.query(
    `SELECT id
     FROM barber_shops
     WHERE owner_id = $1
       AND deleted_at IS NULL`,
    [ownerId]
  );

  const shopIds = (shopsRes.rows || []).map((r) => r.id).filter((v) => v != null);
  const shopCount = shopIds.length;

  let barbersCount = 0;
  if (shopIds.length > 0) {
    const barbersRes = await client.query(
      `SELECT COUNT(*)::int as count
       FROM users
       WHERE deleted_at IS NULL
         AND LOWER(role) = 'barber'
         AND shop_id = ANY($1::int[])`,
      [shopIds]
    );
    barbersCount = Number(barbersRes.rows[0]?.count || 0) || 0;
  }

  const ownerCountsAsProfessionalRes = await client.query(
    `SELECT 1
     FROM users u
     JOIN barber_shops bs ON bs.id = u.shop_id
     WHERE u.id = $1
       AND u.deleted_at IS NULL
       AND bs.owner_id = $1
       AND bs.deleted_at IS NULL
     LIMIT 1`,
    [ownerId]
  );
  const ownerCountsAsProfessional = ownerCountsAsProfessionalRes.rows.length > 0;

  const professionalCount = barbersCount + (ownerCountsAsProfessional ? 1 : 0);

  return {
    shopCount,
    professionalCount,
    barbersCount,
    ownerCountsAsProfessional,
  };
};

const PLAN_TIERS = [
  {
    code: 'basic_1',
    name: 'Básico 1',
    priceDop: 1000,
    limits: { shops: 1, professionals: 2 },
  },
  {
    code: 'basic_2',
    name: 'Básico 2',
    priceDop: 1500,
    limits: { shops: 1, professionals: 3 },
  },
  {
    code: 'pro',
    name: 'Pro',
    priceDop: 2000,
    limits: { shops: 2, professionals: 6 },
  },
  {
    code: 'premium',
    name: 'Premium',
    priceDop: 2500,
    limits: { shops: 3, professionals: 12 },
  },
];

const selectTierForUsage = ({ shopCount, professionalCount }) => {
  const shops = Math.max(0, Number(shopCount) || 0);
  const pros = Math.max(0, Number(professionalCount) || 0);

  const tier = PLAN_TIERS.find((t) => shops <= t.limits.shops && pros <= t.limits.professionals) || null;
  const maxTier = PLAN_TIERS[PLAN_TIERS.length - 1];

  const overShops = Math.max(0, shops - maxTier.limits.shops);
  const overProfessionals = Math.max(0, pros - maxTier.limits.professionals);
  const isOverLimit = tier == null && (overShops > 0 || overProfessionals > 0);

  return {
    tier,
    isOverLimit,
    overage: {
      shops: overShops,
      professionals: overProfessionals,
    },
    normalized: {
      shopCount: shops,
      professionalCount: pros,
    },
  };
};

export const computeMonthlyPriceDop = ({ shopCount, professionalCount }) => {
  const usage = selectTierForUsage({ shopCount, professionalCount });

  if (!usage.tier && usage.isOverLimit) {
    return {
      currency: 'DOP',
      tier: null,
      total: null,
      isOverLimit: true,
      overage: usage.overage,
    };
  }

  const tier = usage.tier || PLAN_TIERS[0];
  return {
    currency: 'DOP',
    tier: {
      code: tier.code,
      name: tier.name,
      priceDop: tier.priceDop,
      limits: tier.limits,
    },
    total: tier.priceDop,
    isOverLimit: false,
    overage: usage.overage,
  };
};

export const getOrCreateOwnerSubscription = async (client, ownerId) => {
  const existing = await client.query(
    `SELECT *
     FROM subscriptions
     WHERE owner_id = $1
     LIMIT 1`,
    [ownerId]
  );

  if (existing.rows.length > 0) return existing.rows[0];

  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const graceEnd = new Date(periodEnd.getTime() + 5 * 24 * 60 * 60 * 1000);

  const insert = await client.query(
    `INSERT INTO subscriptions (
      owner_id,
      status,
      current_period_start,
      current_period_end,
      grace_period_end,
      last_alert_sent_at
    ) VALUES ($1, $2, $3, $4, $5, NULL)
    RETURNING *`,
    [ownerId, 'active', now.toISOString(), periodEnd.toISOString(), graceEnd.toISOString()]
  );

  return insert.rows[0];
};

export const computeSubscriptionState = (subscriptionRow) => {
  const now = new Date();
  const periodEnd = parsePgTimestamp(subscriptionRow?.current_period_end);
  const graceEnd = parsePgTimestamp(subscriptionRow?.grace_period_end);

  const isActive = periodEnd != null && now <= periodEnd;
  const isInGrace = !isActive && graceEnd != null && now <= graceEnd;
  const isBlocked = !isActive && !isInGrace;

  return {
    now,
    periodEnd,
    graceEnd,
    isActive,
    isInGrace,
    isBlocked,
  };
};

export const ensureDailySubscriptionExpiredNotification = async (client, ownerId, subscriptionRow) => {
  const state = computeSubscriptionState(subscriptionRow);
  if (!state.periodEnd) return;
  if (state.isActive) return;

  const lastAlert = parsePgTimestamp(subscriptionRow?.last_alert_sent_at);
  const todayKey = state.now.toISOString().slice(0, 10);
  const lastKey = lastAlert ? lastAlert.toISOString().slice(0, 10) : null;
  if (lastKey === todayKey) return;

  const blockDate = state.graceEnd ? state.graceEnd.toISOString().slice(0, 10) : null;
  const title = 'Tu plan venció';
  const message = blockDate
    ? `Tu suscripción venció. Renueva antes del día ${blockDate} o tu sistema dejará de funcionar.`
    : 'Tu suscripción venció. Renueva para evitar que tu sistema deje de funcionar.';

  await client.query(
    `INSERT INTO notifications (
      user_id,
      type,
      title,
      message,
      status,
      payload,
      created_at,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
    [
      ownerId,
      'SUBSCRIPTION_EXPIRED',
      title,
      message,
      'PENDING',
      {
        periodEnd: state.periodEnd ? state.periodEnd.toISOString() : null,
        graceEnd: state.graceEnd ? state.graceEnd.toISOString() : null,
      },
    ]
  );

  await client.query(
    `UPDATE subscriptions
     SET last_alert_sent_at = NOW(),
         updated_at = NOW()
     WHERE owner_id = $1`,
    [ownerId]
  );
};

export const enforceShopSubscriptionForBooking = async (client, shopId) => {
  const shopRes = await client.query(
    `SELECT owner_id
     FROM barber_shops
     WHERE id = $1
       AND deleted_at IS NULL`,
    [shopId]
  );

  if (shopRes.rows.length === 0) {
    const err = new Error('Barbería no encontrada');
    err.status = 404;
    throw err;
  }

  const ownerId = shopRes.rows[0]?.owner_id;
  if (ownerId == null) {
    const err = new Error('La barbería no tiene dueño asignado');
    err.status = 409;
    throw err;
  }

  const subscription = await getOrCreateOwnerSubscription(client, ownerId);
  const state = computeSubscriptionState(subscription);

  await ensureDailySubscriptionExpiredNotification(client, ownerId, subscription);

  if (state.isBlocked) {
    const blockDate = state.graceEnd ? state.graceEnd.toISOString().slice(0, 10) : null;
    const err = new Error(
      blockDate
        ? `Este negocio tiene el plan vencido. El propietario debe renovar (bloqueado desde ${blockDate}).`
        : 'Este negocio tiene el plan vencido. El propietario debe renovar.'
    );
    err.status = 402;
    err.details = {
      ownerId,
      periodEnd: state.periodEnd ? state.periodEnd.toISOString() : null,
      graceEnd: state.graceEnd ? state.graceEnd.toISOString() : null,
    };
    throw err;
  }

  return {
    ownerId,
    subscription,
    state,
  };
};

export const enforceOwnerSubscriptionForManagement = async (client, ownerId) => {
  if (ownerId == null) {
    const err = new Error('ownerId requerido');
    err.status = 400;
    throw err;
  }

  const subscription = await getOrCreateOwnerSubscription(client, ownerId);
  const state = computeSubscriptionState(subscription);

  await ensureDailySubscriptionExpiredNotification(client, ownerId, subscription);

  if (state.isBlocked) {
    const blockDate = state.graceEnd ? state.graceEnd.toISOString().slice(0, 10) : null;
    const err = new Error(
      blockDate
        ? `Tu plan está vencido. Renueva (bloqueado desde ${blockDate}).`
        : 'Tu plan está vencido. Renueva para continuar.'
    );
    err.status = 402;
    err.details = {
      ownerId,
      periodEnd: state.periodEnd ? state.periodEnd.toISOString() : null,
      graceEnd: state.graceEnd ? state.graceEnd.toISOString() : null,
    };
    throw err;
  }

  return {
    ownerId,
    subscription,
    state,
  };
};

export const isAdminRole = (role) => normalizeRole(role).includes('admin');

export const getDbClient = async () => pool.connect();
