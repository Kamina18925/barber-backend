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

// GET /api/barber-availability
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT barber_id, day, start_time, end_time FROM barber_availability'
    );

    // Normalizar a estructura { barber_id, availability: [{ day, startTime, endTime }, ...] }
    const grouped = {};
    (result.rows || []).forEach(row => {
      const barberId = row.barber_id;
      if (!grouped[barberId]) grouped[barberId] = [];
      grouped[barberId].push({
        day: row.day,
        startTime: row.start_time,
        endTime: row.end_time,
      });
    });

    const response = Object.entries(grouped).map(([barberId, availability]) => ({
      barber_id: barberId,
      availability,
    }));

    res.json(response);
  } catch (error) {
    console.error('Error al obtener disponibilidad de barberos:', error);
    res.status(500).json({ message: 'Error al obtener disponibilidad de barberos' });
  }
});

// PUT /api/barber-availability/:barberId
router.put('/:barberId', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { barberId } = req.params;
    const { availability } = req.body || {};

    await client.query('BEGIN');

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

    // Borramos la disponibilidad anterior de ese barbero
    await client.query('DELETE FROM barber_availability WHERE barber_id = $1', [barberId]);

    const items = Array.isArray(availability) ? availability : [];

    for (const item of items) {
      if (!item.day || !item.startTime || !item.endTime) continue;
      await client.query(
        `INSERT INTO barber_availability (barber_id, day, start_time, end_time)
         VALUES ($1, $2, $3, $4)`,
        [barberId, item.day, item.startTime, item.endTime]
      );
    }

    await client.query('COMMIT');
    return res.json({ barberId: Number(barberId), availability: items });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
    }
    console.error('Error al guardar disponibilidad de barbero:', error);
    return res.status(500).json({ message: 'Error al guardar disponibilidad de barbero' });
  } finally {
    client.release();
  }
});

export default router;
