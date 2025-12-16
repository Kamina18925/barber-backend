import express from 'express';
import pool from '../db/connection.js';

const router = express.Router();

// Reemplazar todas las relaciones de servicios de UN barbero concreto
router.put('/:barberId', async (req, res) => {
  const { barberId } = req.params;
  const { serviceIds } = req.body; // [serviceId, ...]

  if (!Array.isArray(serviceIds)) {
    return res.status(400).json({ message: 'serviceIds debe ser un arreglo de IDs de servicio' });
  }

  try {
    await pool.query('BEGIN');

    // Borrar relaciones actuales de ese barbero
    await pool.query('DELETE FROM barber_services WHERE barber_id::text = $1::text', [String(barberId)]);

    // Insertar nuevas relaciones
    for (const sid of serviceIds) {
      if (sid === undefined || sid === null || String(sid).trim() === '') continue;
      await pool.query(
        'INSERT INTO barber_services (barber_id, service_id) VALUES ($1, $2) ON CONFLICT (barber_id, service_id) DO NOTHING',
        [barberId, sid]
      );
    }

    await pool.query('COMMIT');
    return res.json({ barberId, serviceIds });
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error al guardar servicios de un barbero:', error);
    return res.status(500).json({ message: 'Error al guardar servicios de un barbero' });
  }
});

export default router;
