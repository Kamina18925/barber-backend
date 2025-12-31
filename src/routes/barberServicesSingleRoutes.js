import express from 'express';
import pool from '../db/connection.js';
import { authenticateToken } from '../middleware/auth.js';
import { enforceShopSubscriptionForBooking } from '../services/subscriptionService.js';

const router = express.Router();

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

// Reemplazar todas las relaciones de servicios de UN barbero concreto
router.put('/:barberId', authenticateToken, async (req, res) => {
  const { barberId } = req.params;
  const { serviceIds } = req.body; // [serviceId, ...]

  if (!Array.isArray(serviceIds)) {
    return res.status(400).json({ message: 'serviceIds debe ser un arreglo de IDs de servicio' });
  }

  const client = await pool.connect();
  try {
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

    // Borrar relaciones actuales de ese barbero
    await client.query('DELETE FROM barber_services WHERE barber_id::text = $1::text', [String(barberId)]);

    // Insertar nuevas relaciones
    for (const sid of serviceIds) {
      if (sid === undefined || sid === null || String(sid).trim() === '') continue;
      await client.query(
        'INSERT INTO barber_services (barber_id, service_id) VALUES ($1, $2) ON CONFLICT (barber_id, service_id) DO NOTHING',
        [barberId, sid]
      );
    }

    await client.query('COMMIT');
    return res.json({ barberId, serviceIds });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
    }
    console.error('Error al guardar servicios de un barbero:', error);
    return res.status(500).json({ message: 'Error al guardar servicios de un barbero' });
  } finally {
    client.release();
  }
});

export default router;
