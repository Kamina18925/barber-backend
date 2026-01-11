import pool from '../db/connection.js';

const normalizePlatform = (raw) => {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  if (v.includes('android')) return 'android';
  if (v.includes('ios')) return 'ios';
  if (v.includes('web')) return 'web';
  return v;
};

export const registerFcmToken = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Authentication required' });

    const { token, platform, deviceId, device_id } = req.body || {};
    const finalToken = String(token || '').trim();
    const finalPlatform = normalizePlatform(platform);
    const finalDeviceId = String(deviceId ?? device_id ?? '').trim() || null;

    if (!finalToken) return res.status(400).json({ message: 'token es requerido' });

    await client.query('BEGIN');

    await client.query(
      `INSERT INTO fcm_tokens (user_id, token, platform, device_id, created_at, updated_at, last_seen_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
       ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             platform = COALESCE(EXCLUDED.platform, fcm_tokens.platform),
             device_id = COALESCE(EXCLUDED.device_id, fcm_tokens.device_id),
             updated_at = NOW(),
             last_seen_at = NOW()`,
      [userId, finalToken, finalPlatform, finalDeviceId]
    );

    await client.query('COMMIT');
    try {
      const prefix = finalToken ? `${finalToken.slice(0, 12)}...` : '';
      console.log(
        `FCM token registered: userId=${String(userId)} platform=${String(finalPlatform || '')} deviceId=${String(finalDeviceId || '')} token=${prefix}`
      );
    } catch {
    }
    return res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error registerFcmToken:', error);
    return res.status(500).json({ message: 'Error del servidor al registrar token' });
  } finally {
    client.release();
  }
};

export const unregisterFcmToken = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Authentication required' });

    const { token } = req.body || {};
    const finalToken = String(token || '').trim();

    await client.query('BEGIN');

    if (finalToken) {
      await client.query(
        `DELETE FROM fcm_tokens
         WHERE user_id = $1 AND token = $2`,
        [userId, finalToken]
      );
    } else {
      await client.query(
        `DELETE FROM fcm_tokens
         WHERE user_id = $1`,
        [userId]
      );
    }

    await client.query('COMMIT');
    try {
      const prefix = finalToken ? `${finalToken.slice(0, 12)}...` : '';
      console.log(`FCM token unregistered: userId=${String(userId)} token=${prefix}`);
    } catch {
    }
    return res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error unregisterFcmToken:', error);
    return res.status(500).json({ message: 'Error del servidor al desregistrar token' });
  } finally {
    client.release();
  }
};
