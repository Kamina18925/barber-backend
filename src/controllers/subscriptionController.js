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

const requireAdmin = (req) => {
  const role = normalizeRole(req.user?.role);
  if (!role.includes('admin')) {
    const err = new Error('Acceso denegado: solo admin');
    err.status = 403;
    throw err;
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

const renewSubscription30Days = async (client, ownerId) => {
  const sub = await getOrCreateOwnerSubscription(client, ownerId);

  const now = new Date();
  const currentEnd = sub?.current_period_end ? new Date(sub.current_period_end) : null;
  const start = currentEnd && currentEnd > now ? currentEnd : now;
  const periodEnd = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
  const graceEnd = new Date(periodEnd.getTime() + 5 * 24 * 60 * 60 * 1000);

  const updated = await client.query(
    `UPDATE subscriptions
     SET status = 'active',
         current_period_start = $2,
         current_period_end = $3,
         grace_period_end = $4,
         updated_at = NOW()
     WHERE owner_id = $1
     RETURNING *`,
    [ownerId, start.toISOString(), periodEnd.toISOString(), graceEnd.toISOString()]
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

    const currency = getPaypalCurrency();
    const amountValue = computePaypalAmountFromDop(pricing?.total || 0);
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

    return res.json({
      ownerId: Number(ownerId),
      subscription: {
        status: sub.status,
        current_period_start: sub.current_period_start,
        current_period_end: sub.current_period_end,
        grace_period_end: sub.grace_period_end,
      },
      state: {
        isActive: state.isActive,
        isInGrace: state.isInGrace,
        isBlocked: state.isBlocked,
        periodEnd: state.periodEnd ? state.periodEnd.toISOString() : null,
        graceEnd: state.graceEnd ? state.graceEnd.toISOString() : null,
      },
      usage,
      pricing,
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
