import admin from 'firebase-admin';
import pool from '../db/connection.js';

let initialized = false;
let initAttempted = false;
let initLogged = false;

const parseServiceAccount = () => {
  const base64 = String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '').trim();
  if (base64) {
    const json = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(json);
  }

  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw) {
    return JSON.parse(raw);
  }

  return null;
};

const ensureInitialized = () => {
  if (initialized) return true;
  if (initAttempted) return false;
  initAttempted = true;

  try {
    const sa = parseServiceAccount();
    if (sa) {
      admin.initializeApp({
        credential: admin.credential.cert(sa),
      });
      initialized = true;
      if (!initLogged) {
        initLogged = true;
        console.log('FCM initialized (service account).');
      }
      return true;
    }

    if (String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim()) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
      initialized = true;
      if (!initLogged) {
        initLogged = true;
        console.log('FCM initialized (application default credentials).');
      }
      return true;
    }

    return false;
  } catch (e) {
    console.warn('FCM init error:', e?.message || e);
    return false;
  }
};

export const isFcmEnabled = () => ensureInitialized();

export const getTokensForUser = async (clientOrPool, userId) => {
  const c = clientOrPool || pool;
  const res = await c.query(
    `SELECT token
     FROM fcm_tokens
     WHERE user_id = $1`,
    [userId]
  );
  return (res.rows || []).map((r) => r.token).filter(Boolean);
};

export const sendPushToTokens = async (tokens, { title, body, data } = {}) => {
  if (!ensureInitialized()) return { enabled: false, sent: 0 };
  const list = Array.isArray(tokens) ? tokens.filter(Boolean) : [];
  if (list.length === 0) return { enabled: true, sent: 0 };

  const message = {
    tokens: list,
    notification: {
      title: String(title || 'StyleX'),
      body: String(body || ''),
    },
    data: Object.fromEntries(
      Object.entries(data || {}).map(([k, v]) => [String(k), v == null ? '' : String(v)])
    ),
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        channelId: 'default',
      },
    },
  };

  try {
    const res = await admin.messaging().sendEachForMulticast(message);
    let errorCodes = null;
    let removedInvalidTokens = 0;
    try {
      const responses = Array.isArray(res.responses) ? res.responses : [];
      const tokensToRemove = [];

      for (let i = 0; i < responses.length; i += 1) {
        const r = responses[i];
        if (!r || r.success) continue;
        const code = String(r?.error?.code || '');
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          const t = list[i];
          if (t) tokensToRemove.push(t);
        }
      }

      if (tokensToRemove.length) {
        await pool.query(
          `DELETE FROM fcm_tokens
           WHERE token = ANY($1::text[])`,
          [tokensToRemove]
        );
        removedInvalidTokens = tokensToRemove.length;
      }
    } catch {
    }
    try {
      const successCount = Number(res.successCount || 0) || 0;
      const failureCount = Number(res.failureCount || 0) || 0;
      errorCodes = {};
      const responses = Array.isArray(res.responses) ? res.responses : [];
      responses.forEach((r) => {
        if (r?.success) return;
        const code = String(r?.error?.code || 'unknown');
        errorCodes[code] = (errorCodes[code] || 0) + 1;
      });
      const codesSummary = Object.keys(errorCodes).length
        ? JSON.stringify(errorCodes)
        : '';
      console.log(
        `FCM multicast: tokens=${list.length} sent=${successCount} failures=${failureCount}${codesSummary ? ` codes=${codesSummary}` : ''}`
      );
    } catch {
    }
    return {
      enabled: true,
      sent: res.successCount || 0,
      failures: res.failureCount || 0,
      tokensCount: list.length,
      removedInvalidTokens,
      ...(errorCodes ? { errorCodes } : {}),
    };
  } catch (e) {
    console.warn('FCM send error:', e?.message || e);
    return { enabled: true, sent: 0, error: e?.message || String(e) };
  }
};

export const sendPushToUser = async (userId, payload) => {
  try {
    const tokens = await getTokensForUser(pool, userId);
    return await sendPushToTokens(tokens, payload);
  } catch (e) {
    console.warn('FCM send user error:', e?.message || e);
    return { enabled: isFcmEnabled(), sent: 0, error: e?.message || String(e) };
  }
};

export const sendPushToAdmins = async (payload) => {
  try {
    const res = await pool.query(
      `SELECT t.token
       FROM fcm_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE LOWER(COALESCE(u.role, '')) LIKE '%admin%'`
    );
    const tokens = (res.rows || []).map((r) => r.token).filter(Boolean);
    return await sendPushToTokens(tokens, payload);
  } catch (e) {
    console.warn('FCM send admins error:', e?.message || e);
    return { enabled: isFcmEnabled(), sent: 0, error: e?.message || String(e) };
  }
};
