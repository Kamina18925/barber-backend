import express from 'express';

const router = express.Router();

// Devuelve la hora actual del servidor en ISO (UTC) y en epoch
router.get('/now', (req, res) => {
  const now = new Date();
  res.json({
    nowIso: now.toISOString(),
    nowEpochMs: now.getTime(),
  });
});

export default router;
