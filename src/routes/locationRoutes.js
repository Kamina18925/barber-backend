import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { geocode, nearby, reverse } from '../controllers/locationController.js';

const router = express.Router();

router.get('/geocode', authenticateToken, geocode);
router.get('/nearby', authenticateToken, nearby);
router.get('/reverse', authenticateToken, reverse);

export default router;
