import { Router } from 'express';
import pool from '../db/connection.js';

const router = Router();

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

router.put('/:barberId', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { barberId } = req.params;
    const { breaks } = req.body || {};

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
