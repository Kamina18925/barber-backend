import { Router } from 'express';
import pool from '../db/connection.js';

const router = Router();

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
router.put('/:barberId', async (req, res) => {
  try {
    const { barberId } = req.params;
    const { availability } = req.body || {};

    // Borramos la disponibilidad anterior de ese barbero
    await pool.query('DELETE FROM barber_availability WHERE barber_id = $1', [barberId]);

    const items = Array.isArray(availability) ? availability : [];

    for (const item of items) {
      if (!item.day || !item.startTime || !item.endTime) continue;
      await pool.query(
        `INSERT INTO barber_availability (barber_id, day, start_time, end_time)
         VALUES ($1, $2, $3, $4)`,
        [barberId, item.day, item.startTime, item.endTime]
      );
    }

    res.json({ barberId: Number(barberId), availability: items });
  } catch (error) {
    console.error('Error al guardar disponibilidad de barbero:', error);
    res.status(500).json({ message: 'Error al guardar disponibilidad de barbero' });
  }
});

export default router;
