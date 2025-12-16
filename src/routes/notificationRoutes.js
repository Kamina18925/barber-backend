import express from 'express';
import {
  getNotificationsByUser,
  clearNotificationHistoryForUser,
  respondToNotification,
} from '../controllers/notificationController.js';

const router = express.Router();

// Obtener todas las notificaciones de un usuario
router.get('/user/:userId', getNotificationsByUser);

// Limpiar historial de notificaciones para el cliente (soft delete)
router.post('/user/:userId/clear-history', clearNotificationHistoryForUser);

// Responder a una notificación (aceptar / rechazar propuesta de adelanto)
router.post('/:id/respond', respondToNotification);

export default router;
