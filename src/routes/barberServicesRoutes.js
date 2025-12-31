import express from 'express';
import pool from '../db/connection.js';
import { authenticateToken } from '../middleware/auth.js';
import { enforceShopSubscriptionForBooking } from '../services/subscriptionService.js';

const router = express.Router();

const normalizeRole = (role) => String(role || '').toLowerCase();

const canMutateShop = async (client, reqUser, shopId) => {
  const role = normalizeRole(reqUser?.role);
  const uid = reqUser?.userId;
  if (uid == null) return { ok: false, status: 401, message: 'Authentication required' };

  if (role.includes('admin')) return { ok: true };

  if (role.includes('owner')) {
    const ownRes = await client.query(
      'SELECT 1 FROM barber_shops WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL LIMIT 1',
      [shopId, uid]
    );
    if (ownRes.rows.length > 0) return { ok: true };
  }

  return { ok: false, status: 403, message: 'Acceso denegado' };
};

// Obtener todas las relaciones barber_id <-> service_id
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT barber_id, service_id FROM barber_services'
    );
    return res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener barber_services:', error);
    return res.status(500).json({ message: 'Error al obtener servicios por barbero' });
  }
});

// Reemplazar todas las relaciones de servicios de los barberos de una barbería concreta
router.put('/by-shop/:shopId', authenticateToken, async (req, res) => {
  const { shopId } = req.params;
  const { barberServices } = req.body; // { barberId: [serviceId, ...], ... }

  const shopIdNum = Number(shopId);
  if (!Number.isFinite(shopIdNum)) {
    return res.status(400).json({ message: 'shopId inválido' });
  }

  if (!barberServices || typeof barberServices !== 'object') {
    return res.status(400).json({ message: 'barberServices es obligatorio y debe ser un objeto' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const authz = await canMutateShop(client, req.user, shopIdNum);
    if (!authz.ok) {
      await client.query('ROLLBACK');
      return res.status(authz.status).json({ message: authz.message });
    }

    try {
      await enforceShopSubscriptionForBooking(client, shopIdNum);
    } catch (e) {
      await client.query('ROLLBACK');
      return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
    }

    // Obtener todos los barberos de esa barbería
    const barbersResult = await client.query(
      'SELECT id FROM users WHERE role LIKE $1 AND shop_id = $2',
      ['%barber%', shopIdNum]
    );
    const barberIds = barbersResult.rows.map(r => r.id);

    if (barberIds.length === 0) {
      await client.query('COMMIT');
      return res.json({ message: 'No hay barberos para esta barbería', barberIds: [] });
    }

    // Eliminar relaciones actuales de esos barberos
    await client.query(
      'DELETE FROM barber_services WHERE barber_id::text = ANY($1::text[])',
      [barberIds.map(x => String(x))]
    );

    // Insertar nuevas relaciones
    const inserts = [];
    for (const [barberIdStr, serviceIds] of Object.entries(barberServices)) {
      const barberId = barberIdStr;
      if (barberId == null || String(barberId).trim() === '') continue;
      if (!Array.isArray(serviceIds)) continue;

      for (const svcId of serviceIds) {
        if (svcId == null || String(svcId).trim() === '') continue;
        inserts.push({ barberId, serviceId: svcId });
      }
    }

    for (const row of inserts) {
      await client.query(
        'INSERT INTO barber_services (barber_id, service_id) VALUES ($1, $2) ON CONFLICT (barber_id, service_id) DO NOTHING',
        [row.barberId, row.serviceId]
      );
    }

    await client.query('COMMIT');
    return res.json({ message: 'Servicios por barbero actualizados', count: inserts.length });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al actualizar barber_services por barbería:', error);
    return res.status(500).json({ message: 'Error al guardar servicios por barbero' });
  } finally {
    client.release();
  }
});

export default router;
