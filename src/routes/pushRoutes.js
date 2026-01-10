import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { registerFcmToken, unregisterFcmToken } from '../controllers/pushController.js';

const router = express.Router();

router.post('/register', authenticateToken, registerFcmToken);
router.post('/unregister', authenticateToken, unregisterFcmToken);

export default router;
