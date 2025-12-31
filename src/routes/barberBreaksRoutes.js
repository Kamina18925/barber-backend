import { Router } from 'express';
import pool from '../db/connection.js';
import { authenticateToken } from '../middleware/auth.js';
import { enforceShopSubscriptionForBooking } from '../services/subscriptionService.js';

const router = Router();

const normalizeRole = (role) => String(role || '').toLowerCase();

const canMutateBarber = async (client, reqUser, barberId) => {
  const role = normalizeRole(reqUser?.role);
  const uid = reqUser?.userId;
  if (uid == null) return { ok: false, status: 401, message: 'Authentication required' };

  if (role.includes('admin')) return { ok: true };
  if (role.includes('barber') && String(uid) === String(barberId)) return { ok: true };

  if (role.includes('owner')) {
    const ownRes = await client.query(
      `SELECT 1
       FROM users b
       JOIN barber_shops bs ON bs.id = b.shop_id
       WHERE b.id = $1
         AND bs.owner_id = $2
         AND bs.deleted_at IS NULL
       LIMIT 1`,
      [barberId, uid]
    );
    if (ownRes.rows.length > 0) return { ok: true };
  }

  return { ok: false, status: 403, message: 'Acceso denegado' };
};

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, barber_id, day, break_type, start_time, end_time, enabled
       FROM barber_breaks`
    );

    const grouped = {};
    (result.rows || []).forEach((row) => {
      const barberId = row.barber_id;
      if (!grouped[barberId]) grouped[barberId] = [];
      grouped[barberId].push({
        id: row.id,
        day: row.day,
        type: row.break_type,
        startTime: row.start_time,
        endTime: row.end_time,
        enabled: row.enabled !== false,
      });
    });

    const response = Object.entries(grouped).map(([barberId, breaks]) => ({
      barber_id: Number(barberId),
      breaks,
    }));

    return res.json(response);
  } catch (error) {
    if (error && error.code === '42P01') {
      return res.json([]);
    }
    console.error('Error al obtener descansos de barberos:', error);
    return res.status(500).json({ message: 'Error al obtener descansos de barberos' });
  }
});

router.put('/:barberId', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { barberId } = req.params;
    const { breaks } = req.body || {};

    const authz = await canMutateBarber(client, req.user, barberId);
    if (!authz.ok) {
      await client.query('ROLLBACK');
      return res.status(authz.status).json({ message: authz.message });
    }

    const barberRes = await client.query('SELECT shop_id FROM users WHERE id = $1', [barberId]);
    const shopId = barberRes.rows[0]?.shop_id ?? null;
    if (shopId != null) {
      try {
        await enforceShopSubscriptionForBooking(client, shopId);
      } catch (e) {
        await client.query('ROLLBACK');
        return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
      }
    }

    await client.query('DELETE FROM barber_breaks WHERE barber_id = $1', [barberId]);

    const items = Array.isArray(breaks) ? breaks : [];

    for (const item of items) {
      const day = item.day;
      const type = item.type || item.break_type;
      const startTime = item.startTime || item.start_time;
      const endTime = item.endTime || item.end_time;
      const enabled = item.enabled !== false;

      if (!day || !type || !startTime || !endTime) continue;

      await client.query(
        `INSERT INTO barber_breaks (barber_id, day, break_type, start_time, end_time, enabled)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [barberId, day, type, startTime, endTime, enabled]
      );
    }

    await client.query('COMMIT');

    return res.json({ barberId: Number(barberId), breaks: items });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al guardar descansos de barbero:', error);
    return res.status(500).json({ message: 'Error al guardar descansos de barbero' });
  } finally {
    client.release();
  }
});

export default router;
