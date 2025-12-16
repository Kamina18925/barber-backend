import express from 'express';
import pool from '../db/connection.js';

const router = express.Router();

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
router.put('/by-shop/:shopId', async (req, res) => {
  const { shopId } = req.params;
  const { barberServices } = req.body; // { barberId: [serviceId, ...], ... }

  if (!barberServices || typeof barberServices !== 'object') {
    return res.status(400).json({ message: 'barberServices es obligatorio y debe ser un objeto' });
  }

  try {
    await pool.query('BEGIN');

    // Obtener todos los barberos de esa barbería
    const barbersResult = await pool.query(
      'SELECT id FROM users WHERE role LIKE $1 AND shop_id = $2',
      ['%barber%', shopId]
    );
    const barberIds = barbersResult.rows.map(r => r.id);

    if (barberIds.length === 0) {
      await pool.query('COMMIT');
      return res.json({ message: 'No hay barberos para esta barbería', barberIds: [] });
    }

    // Eliminar relaciones actuales de esos barberos
    await pool.query(
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
      await pool.query(
        'INSERT INTO barber_services (barber_id, service_id) VALUES ($1, $2) ON CONFLICT (barber_id, service_id) DO NOTHING',
        [row.barberId, row.serviceId]
      );
    }

    await pool.query('COMMIT');
    return res.json({ message: 'Servicios por barbero actualizados', count: inserts.length });
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error al actualizar barber_services por barbería:', error);
    return res.status(500).json({ message: 'Error al guardar servicios por barbero' });
  }
});

export default router;
