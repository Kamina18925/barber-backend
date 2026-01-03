import pool from '../db/connection.js';
import {
  computeMonthlyPriceDop,
  computeOwnerUsageCounts,
  computeSubscriptionState,
  getOrCreateOwnerSubscription,
} from '../services/subscriptionService.js';

const normalizeRole = (role) => String(role || '').toLowerCase();

const canAccessOwner = (req, ownerId) => {
  const role = normalizeRole(req.user?.role);
  if (role.includes('admin')) return true;
  const uid = req.user?.userId;
  return uid != null && String(uid) === String(ownerId);
};

const PLAN_TIERS = [
  { code: 'basic_1', name: 'Básico 1', priceDop: 1000, limits: { shops: 1, professionals: 2 } },
  { code: 'basic_2', name: 'Básico 2', priceDop: 1500, limits: { shops: 1, professionals: 3 } },
  { code: 'pro', name: 'Pro', priceDop: 2000, limits: { shops: 2, professionals: 6 } },
  { code: 'premium', name: 'Premium', priceDop: 2500, limits: { shops: 3, professionals: 12 } },
];

const getTierForCode = (planCode) => {
  const code = String(planCode || '').trim();
  return PLAN_TIERS.find((t) => t.code === code) || null;
};

const VALID_PLAN_CODES = new Set(['basic_1', 'basic_2', 'pro', 'premium']);

const getPaypalPlanIdForCode = (planCode) => {
  const code = String(planCode || '').trim();
  if (!VALID_PLAN_CODES.has(code)) return null;

  const envMap = {
    basic_1: process.env.PAYPAL_PLAN_ID_BASIC_1,
    basic_2: process.env.PAYPAL_PLAN_ID_BASIC_2,
    pro: process.env.PAYPAL_PLAN_ID_PRO,
    premium: process.env.PAYPAL_PLAN_ID_PREMIUM,
  };
  const planId = String(envMap[code] || '').trim();
  return planId || null;
};

const getPlanCodeForPaypalPlanId = (paypalPlanId) => {
  const pid = String(paypalPlanId || '').trim();
  if (!pid) return null;

  const reverse = {
    [String(process.env.PAYPAL_PLAN_ID_BASIC_1 || '').trim()]: 'basic_1',
    [String(process.env.PAYPAL_PLAN_ID_BASIC_2 || '').trim()]: 'basic_2',
    [String(process.env.PAYPAL_PLAN_ID_PRO || '').trim()]: 'pro',
    [String(process.env.PAYPAL_PLAN_ID_PREMIUM || '').trim()]: 'premium',
  };

  return reverse[pid] || null;
};

const getPublicAppUrl = (req) => {
  const fromEnv = String(process.env.FRONTEND_PUBLIC_URL || process.env.APP_PUBLIC_URL || '').trim();
  if (fromEnv) return fromEnv;

  const origin = String(req.headers?.origin || '').trim();
  if (origin) return origin;

  const referer = String(req.headers?.referer || '').trim();
  if (referer) {
    try {
      const u = new URL(referer);
      return u.origin;
    } catch {
      // ignore
    }
  }

  return 'http://localhost:5173';
};

const verifyPaypalWebhookSignature = async ({ headers, event }) => {
  const webhookId = String(process.env.PAYPAL_WEBHOOK_ID || '').trim();
  if (!webhookId) {
    const err = new Error('Falta PAYPAL_WEBHOOK_ID para verificar webhooks de PayPal');
    err.status = 500;
    throw err;
  }

  const transmissionId = headers['paypal-transmission-id'];
  const transmissionTime = headers['paypal-transmission-time'];
  const transmissionSig = headers['paypal-transmission-sig'];
  const certUrl = headers['paypal-cert-url'];
  const authAlgo = headers['paypal-auth-algo'];

  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
    const err = new Error('Headers de webhook PayPal incompletos');
    err.status = 400;
    throw err;
  }

  const accessToken = await getPaypalAccessToken();
  const baseUrl = getPaypalBaseUrl();

  const payload = {
    transmission_id: transmissionId,
    transmission_time: transmissionTime,
    cert_url: certUrl,
    auth_algo: authAlgo,
    transmission_sig: transmissionSig,
    webhook_id: webhookId,
    webhook_event: event,
  };

  const res = await fetch(`${baseUrl}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.message || 'No se pudo verificar firma de webhook PayPal');
    err.status = 502;
    err.details = data;
    throw err;
  }

  return String(data?.verification_status || '').toUpperCase() === 'SUCCESS';
};

const requireAdmin = (req) => {
  const role = normalizeRole(req.user?.role);
  if (!role.includes('admin')) {
    const err = new Error('Acceso denegado: solo admin');
    err.status = 403;
    throw err;
  }
};

export const paypalCreateSubscription = async (req, res) => {
  const client = await pool.connect();
  try {
    const ownerId = req.user?.userId;
    if (!ownerId) return res.status(401).json({ message: 'Authentication required' });

    const role = normalizeRole(req.user?.role);
    if (!role.includes('admin') && !role.includes('owner')) {
      return res.status(403).json({ message: 'Acceso denegado' });
    }

    const { planCode } = req.body || {};
    const code = String(planCode || '').trim();
    if (!VALID_PLAN_CODES.has(code)) {
      return res.status(400).json({ message: 'planCode inválido' });
    }

    const planId = getPaypalPlanIdForCode(code);
    if (!planId) {
      return res.status(500).json({ message: `Falta configurar PAYPAL_PLAN_ID_* para planCode=${code}` });
    }

    const usage = await computeOwnerUsageCounts(client, ownerId);
    const pricing = computeMonthlyPriceDop(usage);
    if (pricing?.isOverLimit) {
      return res.status(400).json({
        message: 'Tu cuenta excede los límites del plan. Ajusta negocios/profesionales o contacta al administrador.',
        pricing,
        usage,
      });
    }

    const tierLimits = pricing?.tier?.limits || null;
    if (tierLimits && (Number(usage?.shopCount || 0) > Number(tierLimits.shops) || Number(usage?.professionalCount || 0) > Number(tierLimits.professionals))) {
      return res.status(400).json({
        message: 'Tu uso actual excede el plan seleccionado. Elige un plan superior.',
        pricing,
        usage,
      });
    }

    const appUrl = getPublicAppUrl(req);
    const returnUrl = `${appUrl}/?paypal_subscription_success=1`;
    const cancelUrl = `${appUrl}/?paypal_subscription_cancel=1`;

    const accessToken = await getPaypalAccessToken();
    const baseUrl = getPaypalBaseUrl();

    const payload = {
      plan_id: planId,
      custom_id: `owner_${ownerId}_plan_${code}`,
      application_context: {
        brand_name: 'Stylex',
        locale: 'es-DO',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    };

    const ppRes = await fetch(`${baseUrl}/v1/billing/subscriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const ppData = await ppRes.json().catch(() => null);
    if (!ppRes.ok) {
      const err = new Error(ppData?.message || 'Error creando suscripción de PayPal');
      err.status = 502;
      err.details = ppData;
      throw err;
    }

    const paypalSubscriptionId = ppData?.id || null;
    const approveLink = Array.isArray(ppData?.links)
      ? ppData.links.find((l) => String(l?.rel || '').toLowerCase() === 'approve')
      : null;
    const approvalUrl = approveLink?.href || null;

    if (!paypalSubscriptionId || !approvalUrl) {
      return res.status(502).json({ message: 'Respuesta inválida de PayPal creando suscripción', raw: ppData });
    }

    await client.query('BEGIN');
    await getOrCreateOwnerSubscription(client, ownerId);
    await client.query(
      `UPDATE subscriptions
       SET billing_provider = 'paypal',
           paypal_subscription_id = $2,
           paypal_subscription_status = $3,
           pending_plan_code = $4,
           pending_plan_effective_at = NULL,
           updated_at = NOW()
       WHERE owner_id = $1`,
      [ownerId, paypalSubscriptionId, String(ppData?.status || ''), code]
    );
    await client.query('COMMIT');

    return res.json({ id: paypalSubscriptionId, approvalUrl, raw: ppData });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error paypalCreateSubscription:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Error del servidor' });
  } finally {
    client.release();
  }
};

export const paypalConfirmSubscription = async (req, res) => {
  const client = await pool.connect();
  try {
    const ownerId = req.user?.userId;
    if (!ownerId) return res.status(401).json({ message: 'Authentication required' });

    const role = normalizeRole(req.user?.role);
    if (!role.includes('admin') && !role.includes('owner')) {
      return res.status(403).json({ message: 'Acceso denegado' });
    }

    const { subscriptionId } = req.body || {};
    if (!subscriptionId) return res.status(400).json({ message: 'subscriptionId requerido' });

    const accessToken = await getPaypalAccessToken();
    const baseUrl = getPaypalBaseUrl();

    const ppRes = await fetch(`${baseUrl}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const ppData = await ppRes.json().catch(() => null);
    if (!ppRes.ok) {
      const err = new Error(ppData?.message || 'Error consultando suscripción de PayPal');
      err.status = 502;
      err.details = ppData;
      throw err;
    }

    const status = String(ppData?.status || '').toUpperCase();
    if (!status) {
      return res.status(502).json({ message: 'Respuesta inválida de PayPal', raw: ppData });
    }

    const planCodeFromPaypal = getPlanCodeForPaypalPlanId(ppData?.plan_id);

    await client.query('BEGIN');
    const sub = await getOrCreateOwnerSubscription(client, ownerId);
    if (String(sub.paypal_subscription_id || '') !== String(subscriptionId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'subscriptionId no coincide con el owner' });
    }

    // Source of truth for the paid plan is PayPal's plan_id.
    // Do NOT overwrite plan_code on APPROVAL_PENDING or other non-ACTIVE states.
    if (status !== 'ACTIVE') {
      await client.query(
        `UPDATE subscriptions
         SET billing_provider = 'paypal',
             paypal_subscription_status = $2,
             updated_at = NOW()
         WHERE owner_id = $1`,
        [ownerId, status]
      );
      await client.query('COMMIT');
      return res.json({ success: true, paypal: ppData });
    }

    const resolvedPlanCode = planCodeFromPaypal || sub.pending_plan_code || sub.plan_code || null;
    const nextBillingIso = ppData?.billing_info?.next_billing_time || null;
    const now = new Date();
    const nextBilling = nextBillingIso ? new Date(nextBillingIso) : null;
    const periodEnd =
      nextBilling && !Number.isNaN(nextBilling.getTime())
        ? nextBilling
        : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const graceEnd = new Date(periodEnd.getTime() + 5 * 24 * 60 * 60 * 1000);

    await client.query(
      `UPDATE subscriptions
       SET status = 'active',
           plan_code = COALESCE($2, plan_code),
           billing_provider = 'paypal',
           paypal_subscription_status = $3,
           pending_plan_code = NULL,
           pending_plan_effective_at = NULL,
           current_period_start = $4,
           current_period_end = $5,
           grace_period_end = $6,
           updated_at = NOW()
       WHERE owner_id = $1
       RETURNING *`,
      [ownerId, resolvedPlanCode, status, now.toISOString(), periodEnd.toISOString(), graceEnd.toISOString()]
    );

    await client.query('COMMIT');

    return res.json({ success: true, paypal: ppData });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error paypalConfirmSubscription:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Error del servidor' });
  } finally {
    client.release();
  }
};

export const paypalCancelSubscription = async (req, res) => {
  const client = await pool.connect();
  try {
    const ownerId = req.user?.userId;
    if (!ownerId) return res.status(401).json({ message: 'Authentication required' });

    const role = normalizeRole(req.user?.role);
    if (!role.includes('admin') && !role.includes('owner')) {
      return res.status(403).json({ message: 'Acceso denegado' });
    }

    const sub = await getOrCreateOwnerSubscription(client, ownerId);
    const subscriptionId = sub.paypal_subscription_id;
    if (!subscriptionId) return res.status(400).json({ message: 'No hay suscripción PayPal activa' });

    const accessToken = await getPaypalAccessToken();
    const baseUrl = getPaypalBaseUrl();

    const ppRes = await fetch(`${baseUrl}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'Cancelado por el usuario' }),
    });

    if (!ppRes.ok) {
      const ppData = await ppRes.json().catch(() => null);
      const err = new Error(ppData?.message || 'Error cancelando suscripción PayPal');
      err.status = 502;
      err.details = ppData;
      throw err;
    }

    await client.query(
      `UPDATE subscriptions
       SET paypal_subscription_status = 'CANCELLED',
           updated_at = NOW()
       WHERE owner_id = $1`,
      [ownerId]
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('Error paypalCancelSubscription:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Error del servidor' });
  } finally {
    client.release();
  }
};

export const paypalChangeSubscriptionPlan = async (req, res) => {
  const client = await pool.connect();
  try {
    const ownerId = req.user?.userId;
    if (!ownerId) return res.status(401).json({ message: 'Authentication required' });

    const role = normalizeRole(req.user?.role);
    if (!role.includes('admin') && !role.includes('owner')) {
      return res.status(403).json({ message: 'Acceso denegado' });
    }

    const { planCode } = req.body || {};
    const code = String(planCode || '').trim();
    if (!VALID_PLAN_CODES.has(code)) {
      return res.status(400).json({ message: 'planCode inválido' });
    }

    const planId = getPaypalPlanIdForCode(code);
    if (!planId) {
      return res.status(500).json({ message: `Falta configurar PAYPAL_PLAN_ID_* para planCode=${code}` });
    }

    const sub = await getOrCreateOwnerSubscription(client, ownerId);
    const subscriptionId = sub.paypal_subscription_id;
    if (!subscriptionId) {
      return res.status(400).json({ message: 'No hay suscripción PayPal existente para cambiar de plan' });
    }

    const accessToken = await getPaypalAccessToken();
    const baseUrl = getPaypalBaseUrl();
    const appUrl = getPublicAppUrl(req);
    const returnUrl = `${appUrl}/?paypal_subscription_success=1`;
    const cancelUrl = `${appUrl}/?paypal_subscription_cancel=1`;

    const payload = {
      plan_id: planId,
      application_context: {
        brand_name: 'Stylex',
        locale: 'es-DO',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    };

    const ppRes = await fetch(
      `${baseUrl}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/revise`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    );

    const ppData = await ppRes.json().catch(() => null);
    if (!ppRes.ok) {
      const err = new Error(ppData?.message || 'Error cambiando plan de suscripción PayPal');
      err.status = 502;
      err.details = ppData;
      throw err;
    }

    const approveLink = Array.isArray(ppData?.links)
      ? ppData.links.find((l) => String(l?.rel || '').toLowerCase() === 'approve')
      : null;
    const approvalUrl = approveLink?.href || null;

    await client.query(
      `UPDATE subscriptions
       SET pending_plan_code = $2,
           pending_plan_effective_at = NULL,
           updated_at = NOW()
       WHERE owner_id = $1`,
      [ownerId, code]
    );

    return res.json({ success: true, approvalUrl, raw: ppData });
  } catch (error) {
    console.error('Error paypalChangeSubscriptionPlan:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Error del servidor' });
  } finally {
    client.release();
  }
};

export const paypalWebhook = async (req, res) => {
  const client = await pool.connect();
  try {
    const headers = Object.fromEntries(
      Object.entries(req.headers || {}).map(([k, v]) => [String(k || '').toLowerCase(), v])
    );
    const event = req.body;

    const ok = await verifyPaypalWebhookSignature({ headers, event });
    if (!ok) {
      return res.status(400).json({ message: 'Firma de webhook inválida' });
    }

    const eventType = String(event?.event_type || '').toUpperCase();
    const resource = event?.resource || {};

    const subscriptionId = resource?.billing_agreement_id || resource?.id || resource?.subscription_id || null;
    const transactionId = resource?.id || resource?.sale_id || resource?.transaction_id || null;

    if (!subscriptionId) {
      return res.json({ received: true });
    }

    await client.query('BEGIN');

    const subRes = await client.query(
      `SELECT * FROM subscriptions WHERE paypal_subscription_id = $1 LIMIT 1 FOR UPDATE`,
      [subscriptionId]
    );

    if (subRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ received: true });
    }

    const subRow = subRes.rows[0];
    const ownerId = subRow.owner_id;

    if (eventType.startsWith('BILLING.SUBSCRIPTION.')) {
      const newStatus = String(resource?.status || '').toUpperCase() || eventType;
      await client.query(
        `UPDATE subscriptions
         SET paypal_subscription_status = $2,
             billing_provider = 'paypal',
             updated_at = NOW()
         WHERE owner_id = $1`,
        [ownerId, newStatus]
      );
    }

    const isPaymentSuccessEvent =
      eventType === 'BILLING.SUBSCRIPTION.PAYMENT.SUCCEEDED' ||
      eventType === 'PAYMENT.CAPTURE.COMPLETED' ||
      eventType === 'PAYMENT.SALE.COMPLETED' ||
      (eventType.includes('PAYMENT') &&
        !eventType.includes('FAILED') &&
        !eventType.includes('DENIED') &&
        !eventType.includes('REVERSED') &&
        !eventType.includes('REFUNDED'));

    if (isPaymentSuccessEvent && transactionId) {
      // Sync internal plan_code from PayPal subscription (source of truth)
      try {
        const accessToken = await getPaypalAccessToken();
        const baseUrl = getPaypalBaseUrl();
        const ppRes = await fetch(`${baseUrl}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        });
        const ppData = await ppRes.json().catch(() => null);
        if (ppRes.ok) {
          const planCodeFromPaypal = getPlanCodeForPaypalPlanId(ppData?.plan_id);
          if (planCodeFromPaypal) {
            await client.query(
              `UPDATE subscriptions
               SET plan_code = COALESCE($2, plan_code),
                   updated_at = NOW()
               WHERE owner_id = $1`,
              [ownerId, planCodeFromPaypal]
            );
          }
        }
      } catch (e) {
        // best-effort sync
      }

      const exists = await client.query(
        `SELECT 1 FROM payments WHERE provider = 'paypal_subscription' AND provider_payment_id = $1 LIMIT 1`,
        [String(transactionId)]
      );

      if (exists.rows.length === 0) {
        const renewed = await renewSubscription30Days(client, ownerId);

        const amount = resource?.amount?.total || resource?.amount?.value || resource?.amount?.amount || null;
        const currency = resource?.amount?.currency || resource?.amount?.currency_code || resource?.amount?.currencyCode || null;
        const paidAt = resource?.time || resource?.create_time || null;

        await client.query(
          `INSERT INTO payments (
            owner_id,
            provider,
            status,
            amount,
            currency,
            provider_payment_id,
            metadata,
            paid_at,
            created_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
          [
            ownerId,
            'paypal_subscription',
            'confirmed',
            amount != null ? Number(amount) : null,
            currency ? String(currency).toUpperCase() : null,
            String(transactionId),
            { eventType, subscriptionId, raw: event },
            paidAt ? new Date(paidAt).toISOString() : new Date().toISOString(),
          ]
        );

        await client.query(
          `UPDATE subscriptions
           SET status = 'active',
               billing_provider = 'paypal',
               updated_at = NOW()
           WHERE owner_id = $1`,
          [ownerId]
        );

        await client.query('COMMIT');
        return res.json({ received: true, renewed: Boolean(renewed) });
      }
    }

    await client.query('COMMIT');
    return res.json({ received: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error paypalWebhook:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Error del servidor' });
  } finally {
    client.release();
  }
};

const toIntOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const clampInt = (value, { min, max, fallback }) => {
  const n = toIntOrNull(value);
  if (n == null) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

const getTransferConfig = () => {
  const bankName = String(process.env.TRANSFER_BANK_NAME || '').trim();
  const accountHolder = String(process.env.TRANSFER_ACCOUNT_HOLDER || '').trim();
  const accountNumber = String(process.env.TRANSFER_ACCOUNT_NUMBER || '').trim();
  const accountType = String(process.env.TRANSFER_ACCOUNT_TYPE || '').trim();
  const notes = String(process.env.TRANSFER_NOTES || '').replace(/\\n/g, '\n').trim();

  const enabled = Boolean(bankName || accountHolder || accountNumber || accountType || notes);
  return {
    enabled,
    bankName: bankName || null,
    accountHolder: accountHolder || null,
    accountNumber: accountNumber || null,
    accountType: accountType || null,
    notes: notes || null,
  };
};

const renewSubscription30Days = async (client, ownerId) => {
  const sub = await getOrCreateOwnerSubscription(client, ownerId);

  const usage = await computeOwnerUsageCounts(client, ownerId);
  const pricing = computeMonthlyPriceDop(usage);
  const planCode = sub?.pending_plan_code || sub?.plan_code || pricing?.tier?.code || null;

  const now = new Date();
  const currentEnd = sub?.current_period_end ? new Date(sub.current_period_end) : null;
  const start = currentEnd && currentEnd > now ? currentEnd : now;
  const periodEnd = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
  const graceEnd = new Date(periodEnd.getTime() + 5 * 24 * 60 * 60 * 1000);

  const updated = await client.query(
    `UPDATE subscriptions
     SET status = 'active',
         plan_code = COALESCE($5, plan_code),
         current_period_start = $2,
         current_period_end = $3,
         grace_period_end = $4,
         updated_at = NOW()
     WHERE owner_id = $1
     RETURNING *`,
    [ownerId, start.toISOString(), periodEnd.toISOString(), graceEnd.toISOString(), planCode]
  );

  return updated.rows[0];
};

const getPaypalBaseUrl = () => {
  const mode = String(process.env.PAYPAL_MODE || 'sandbox').trim().toLowerCase();
  return mode === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
};

const assertPaypalConfigured = () => {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) {
    const err = new Error('PayPal no está configurado (faltan PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)');
    err.status = 500;
    throw err;
  }
};

const getPaypalAccessToken = async () => {
  assertPaypalConfigured();

  const baseUrl = getPaypalBaseUrl();
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  const basic = Buffer.from(`${clientId}:${secret}`).toString('base64');

  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error_description || data?.message || 'Error obteniendo access token PayPal');
    err.status = 502;
    err.details = data;
    throw err;
  }

  const token = data?.access_token;
  if (!token) {
    const err = new Error('Respuesta inválida de PayPal (sin access_token)');
    err.status = 502;
    err.details = data;
    throw err;
  }
  return token;
};

const getPaypalCurrency = () => String(process.env.PAYPAL_CURRENCY || 'USD').trim().toUpperCase();

const formatPaypalAmount = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return n.toFixed(2);
};

const computePaypalAmountFromDop = (dopTotal) => {
  const currency = getPaypalCurrency();
  const dop = Number(dopTotal);
  if (!Number.isFinite(dop) || dop <= 0) return null;

  if (currency === 'DOP') {
    return formatPaypalAmount(dop);
  }

  if (currency === 'USD') {
    const rate = Number(process.env.PAYPAL_DOP_TO_USD_RATE);
    if (!Number.isFinite(rate) || rate <= 0) {
      const err = new Error('Falta PAYPAL_DOP_TO_USD_RATE para convertir DOP -> USD');
      err.status = 500;
      throw err;
    }
    return formatPaypalAmount(dop / rate);
  }

  const err = new Error(`Moneda PayPal no soportada: ${currency}`);
  err.status = 500;
  throw err;
};

export const getPaypalConfig = async (req, res) => {
  try {
    assertPaypalConfigured();
    return res.json({
      clientId: process.env.PAYPAL_CLIENT_ID,
      mode: String(process.env.PAYPAL_MODE || 'sandbox'),
      currency: getPaypalCurrency(),
    });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message || 'Error del servidor' });
  }
};

export const paypalCreateOrder = async (req, res) => {
  const client = await pool.connect();
  try {
    const ownerId = req.user?.userId;
    if (!ownerId) return res.status(401).json({ message: 'Authentication required' });

    const role = normalizeRole(req.user?.role);
    if (!role.includes('admin') && !role.includes('owner')) {
      return res.status(403).json({ message: 'Acceso denegado' });
    }

    const usage = await computeOwnerUsageCounts(client, ownerId);
    const pricing = computeMonthlyPriceDop(usage);

    if (pricing?.total == null || !Number.isFinite(Number(pricing.total)) || Number(pricing.total) <= 0) {
      return res.status(400).json({
        message:
          pricing?.isOverLimit
            ? 'Tu cuenta excede los límites del plan. Ajusta negocios/profesionales o contacta al administrador.'
            : 'Monto inválido para crear orden',
        pricing,
        usage,
      });
    }

    const currency = getPaypalCurrency();
    const amountValue = computePaypalAmountFromDop(pricing.total);
    if (Number(amountValue) <= 0) {
      return res.status(400).json({ message: 'Monto inválido para crear orden' });
    }

    const accessToken = await getPaypalAccessToken();
    const baseUrl = getPaypalBaseUrl();

    const payload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: `owner_${ownerId}`,
          amount: {
            currency_code: currency,
            value: amountValue,
          },
          description: 'Suscripción Stylex (30 días)'
        },
      ],
    };

    const ppRes = await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const ppData = await ppRes.json().catch(() => null);
    if (!ppRes.ok) {
      const err = new Error(ppData?.message || 'Error creando orden de PayPal');
      err.status = 502;
      err.details = ppData;
      throw err;
    }

    return res.json({ id: ppData?.id, raw: ppData });
  } catch (error) {
    console.error('Error paypalCreateOrder:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Error del servidor' });
  } finally {
    client.release();
  }
};

export const paypalCaptureOrder = async (req, res) => {
  const client = await pool.connect();
  try {
    const ownerId = req.user?.userId;
    if (!ownerId) return res.status(401).json({ message: 'Authentication required' });

    const role = normalizeRole(req.user?.role);
    if (!role.includes('admin') && !role.includes('owner')) {
      return res.status(403).json({ message: 'Acceso denegado' });
    }

    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ message: 'orderId requerido' });

    const accessToken = await getPaypalAccessToken();
    const baseUrl = getPaypalBaseUrl();

    const ppRes = await fetch(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const ppData = await ppRes.json().catch(() => null);
    if (!ppRes.ok) {
      const err = new Error(ppData?.message || 'Error capturando orden de PayPal');
      err.status = 502;
      err.details = ppData;
      throw err;
    }

    const status = String(ppData?.status || '').toUpperCase();
    if (status !== 'COMPLETED') {
      return res.status(400).json({ message: `Pago no completado (status=${status || 'N/A'})`, raw: ppData });
    }

    const capture = ppData?.purchase_units?.[0]?.payments?.captures?.[0] || null;
    const captureId = capture?.id || null;
    const amount = capture?.amount?.value || null;
    const currency = capture?.amount?.currency_code || String(process.env.PAYPAL_CURRENCY || 'DOP').toUpperCase();
    const paidAt = capture?.create_time || null;

    await client.query('BEGIN');

    const renewed = await renewSubscription30Days(client, ownerId);

    await client.query(
      `INSERT INTO payments (
        owner_id,
        provider,
        status,
        amount,
        currency,
        provider_payment_id,
        metadata,
        paid_at,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [
        ownerId,
        'paypal',
        'confirmed',
        amount != null ? Number(amount) : null,
        currency,
        captureId || orderId,
        { orderId, captureId, raw: ppData },
        paidAt ? new Date(paidAt).toISOString() : new Date().toISOString(),
      ]
    );

    await client.query('COMMIT');

    return res.json({ success: true, subscription: renewed, paypal: ppData });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error paypalCaptureOrder:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Error del servidor' });
  } finally {
    client.release();
  }
};

export const getOwnerSubscriptionSummary = async (req, res) => {
  const client = await pool.connect();
  try {
    const { ownerId } = req.params;
    if (!ownerId) return res.status(400).json({ message: 'ownerId requerido' });

    if (!req.user?.userId) return res.status(401).json({ message: 'Authentication required' });
    if (!canAccessOwner(req, ownerId)) {
      return res.status(403).json({ message: 'Acceso denegado' });
    }

    const sub = await getOrCreateOwnerSubscription(client, ownerId);
    const usage = await computeOwnerUsageCounts(client, ownerId);
    const pricing = computeMonthlyPriceDop(usage);
    const state = computeSubscriptionState(sub);

    const currentPlan = getTierForCode(sub.plan_code);
    const recommendedPlan = pricing?.tier || null;

    const transfer = getTransferConfig();

    return res.json({
      ownerId: Number(ownerId),
      subscription: {
        status: sub.status,
        plan_code: sub.plan_code || null,
        billing_provider: sub.billing_provider || null,
        paypal_subscription_id: sub.paypal_subscription_id || null,
        paypal_subscription_status: sub.paypal_subscription_status || null,
        pending_plan_code: sub.pending_plan_code || null,
        pending_plan_effective_at: sub.pending_plan_effective_at || null,
        current_period_start: sub.current_period_start,
        current_period_end: sub.current_period_end,
        grace_period_end: sub.grace_period_end,
      },
      currentPlan,
      recommendedPlan,
      state: {
        isActive: state.isActive,
        isInGrace: state.isInGrace,
        isBlocked: state.isBlocked,
        periodEnd: state.periodEnd ? state.periodEnd.toISOString() : null,
        graceEnd: state.graceEnd ? state.graceEnd.toISOString() : null,
      },
      usage,
      pricing,
      transfer,
    });
  } catch (error) {
    console.error('Error getOwnerSubscriptionSummary:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Error del servidor' });
  } finally {
    client.release();
  }
};

export const listOwnerPayments = async (req, res) => {
  const client = await pool.connect();
  try {
    const { ownerId } = req.params;
    if (!ownerId) return res.status(400).json({ message: 'ownerId requerido' });

    if (!req.user?.userId) return res.status(401).json({ message: 'Authentication required' });
    if (!canAccessOwner(req, ownerId)) {
      return res.status(403).json({ message: 'Acceso denegado' });
    }

    const limit = clampInt(req.query?.limit, { min: 1, max: 100, fallback: 20 });
    const offset = clampInt(req.query?.offset, { min: 0, max: 100000, fallback: 0 });

    const result = await client.query(
      `SELECT id, owner_id, provider, status, amount, currency, provider_payment_id, metadata, paid_at, created_at
       FROM payments
       WHERE owner_id = $1
       ORDER BY paid_at DESC NULLS LAST, created_at DESC
       LIMIT $2 OFFSET $3`,
      [ownerId, limit, offset]
    );

    return res.json(result.rows);
  } catch (error) {
    console.error('Error listOwnerPayments:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Error del servidor' });
  } finally {
    client.release();
  }
};

export const listPaymentsAdmin = async (req, res) => {
  const client = await pool.connect();
  try {
    requireAdmin(req);

    const ownerId = toIntOrNull(req.query?.ownerId ?? req.query?.owner_id);
    const limit = clampInt(req.query?.limit, { min: 1, max: 200, fallback: 50 });
    const offset = clampInt(req.query?.offset, { min: 0, max: 100000, fallback: 0 });

    const where = [];
    const values = [];
    if (ownerId != null) {
      values.push(ownerId);
      where.push(`p.owner_id = $${values.length}`);
    }
    values.push(limit);
    const limitPos = values.length;
    values.push(offset);
    const offsetPos = values.length;

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await client.query(
      `SELECT p.id, p.owner_id, u.name as owner_name, u.email as owner_email,
              p.provider, p.status, p.amount, p.currency, p.provider_payment_id, p.metadata, p.paid_at, p.created_at
       FROM payments p
       LEFT JOIN users u ON u.id = p.owner_id
       ${whereSql}
       ORDER BY p.paid_at DESC NULLS LAST, p.created_at DESC
       LIMIT $${limitPos} OFFSET $${offsetPos}`,
      values
    );

    return res.json(result.rows);
  } catch (error) {
    console.error('Error listPaymentsAdmin:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Error del servidor' });
  } finally {
    client.release();
  }
};

export const createManualPaymentReport = async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      ownerId,
      amount,
      currency,
      reference,
      referenceText,
      reference_text,
      proofUrl,
      proof_url,
    } = req.body || {};

    if (!req.user?.userId) return res.status(401).json({ message: 'Authentication required' });

    const role = normalizeRole(req.user?.role);
    if (!role.includes('admin') && !role.includes('owner')) {
      return res.status(403).json({ message: 'Acceso denegado' });
    }
    const finalOwnerId = role.includes('admin') ? (ownerId ?? req.user.userId) : req.user.userId;
    const finalReference = reference ?? referenceText ?? reference_text ?? null;
    const finalProofUrl = proofUrl ?? proof_url ?? null;
    const finalCurrency = currency || 'DOP';
    const finalAmount = amount != null ? Number(amount) : null;

    if (!finalOwnerId) return res.status(400).json({ message: 'ownerId requerido' });
    if (!finalReference && !finalProofUrl) {
      return res.status(400).json({ message: 'Debes enviar referencia o comprobante' });
    }

    await client.query('BEGIN');

    await getOrCreateOwnerSubscription(client, finalOwnerId);

    const insert = await client.query(
      `INSERT INTO manual_payment_reports (
        owner_id,
        amount,
        currency,
        reference_text,
        proof_url,
        status,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, 'pending', NOW(), NOW())
      RETURNING *`,
      [finalOwnerId, finalAmount, finalCurrency, finalReference, finalProofUrl]
    );

    await client.query(
      `UPDATE subscriptions
       SET status = 'pending_verification',
           updated_at = NOW()
       WHERE owner_id = $1`,
      [finalOwnerId]
    );

    await client.query('COMMIT');

    return res.status(201).json(insert.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error createManualPaymentReport:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Error del servidor' });
  } finally {
    client.release();
  }
};

export const listManualPaymentReports = async (req, res) => {
  const client = await pool.connect();
  try {
    requireAdmin(req);

    const status = req.query?.status ? String(req.query.status).toLowerCase() : null;
    const where = [];
    const values = [];

    if (status) {
      values.push(status);
      where.push(`LOWER(status) = $${values.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await client.query(
      `SELECT r.*, u.name as owner_name, u.email as owner_email
       FROM manual_payment_reports r
       LEFT JOIN users u ON u.id = r.owner_id
       ${whereSql}
       ORDER BY r.created_at DESC`,
      values
    );

    return res.json(result.rows);
  } catch (error) {
    console.error('Error listManualPaymentReports:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Error del servidor' });
  } finally {
    client.release();
  }
};

export const approveManualPaymentReport = async (req, res) => {
  const client = await pool.connect();
  try {
    requireAdmin(req);

    const { id } = req.params;
    const requesterId = req.user?.userId ?? null;

    await client.query('BEGIN');

    const reportRes = await client.query(
      `SELECT * FROM manual_payment_reports WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (reportRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Reporte no encontrado' });
    }

    const report = reportRes.rows[0];
    if (String(report.status).toLowerCase() !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Este reporte ya fue procesado' });
    }

    const ownerId = report.owner_id;
    const renewed = await renewSubscription30Days(client, ownerId);

    await client.query(
      `INSERT INTO payments (
        owner_id,
        provider,
        status,
        amount,
        currency,
        provider_payment_id,
        metadata,
        paid_at,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), NOW())`,
      [
        ownerId,
        'manual',
        'confirmed',
        report.amount,
        report.currency,
        null,
        {
          reportId: report.id,
          referenceText: report.reference_text,
          proofUrl: report.proof_url,
          approvedBy: requesterId,
        },
      ]
    );

    const updatedReport = await client.query(
      `UPDATE manual_payment_reports
       SET status = 'approved',
           approved_by = $2,
           decided_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, requesterId]
    );

    await client.query('COMMIT');

    return res.json({
      report: updatedReport.rows[0],
      subscription: renewed,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error approveManualPaymentReport:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Error del servidor' });
  } finally {
    client.release();
  }
};

export const rejectManualPaymentReport = async (req, res) => {
  const client = await pool.connect();
  try {
    requireAdmin(req);

    const { id } = req.params;
    const requesterId = req.user?.userId ?? null;

    await client.query('BEGIN');

    const reportRes = await client.query(
      `SELECT * FROM manual_payment_reports WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (reportRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Reporte no encontrado' });
    }

    const report = reportRes.rows[0];
    if (String(report.status).toLowerCase() !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Este reporte ya fue procesado' });
    }

    const updatedReport = await client.query(
      `UPDATE manual_payment_reports
       SET status = 'rejected',
           rejected_by = $2,
           decided_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, requesterId]
    );

    await client.query('COMMIT');

    return res.json({ report: updatedReport.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error rejectManualPaymentReport:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Error del servidor' });
  } finally {
    client.release();
  }
};

export const adminActivateSubscription = async (req, res) => {
  const client = await pool.connect();
  try {
    requireAdmin(req);

    const { ownerId } = req.body || {};
    if (!ownerId) return res.status(400).json({ message: 'ownerId requerido' });

    await client.query('BEGIN');

    const renewed = await renewSubscription30Days(client, ownerId);

    await client.query('COMMIT');

    return res.json({ subscription: renewed });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adminActivateSubscription:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Error del servidor' });
  } finally {
    client.release();
  }
};
