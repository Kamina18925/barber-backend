import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import {
  getAllAppointments,
  getAppointmentsByClient,
  getAppointmentsByBarber,
  getAppointmentsByShop,
  getAppointmentById,
  createAppointment,
  updateAppointment,
  cancelAppointment,
  completeAppointment,
  updateAppointmentPayment,
  updateAppointmentBarberNotes,
  markNoShowAppointment,
  deleteAppointmentById,
  deleteAppointmentsByClientAndStatus,
  createBarberDayOff,
  createBarberLeaveEarly,
  proposeAdvanceAppointment,
  deleteBarberAppointmentsHistory,
} from '../controllers/appointmentController.js';

const router = express.Router();

// Rutas para citas
router.get('/', getAllAppointments);
router.get('/client/:clientId', getAppointmentsByClient);
router.get('/barber/:barberId', getAppointmentsByBarber);
router.get('/shop/:shopId', getAppointmentsByShop);
router.get('/:id', getAppointmentById);
router.post('/', authenticateToken, createAppointment);
router.put('/:id', authenticateToken, updateAppointment);
router.put('/:id/cancel', authenticateToken, cancelAppointment);
router.put('/:id/complete', authenticateToken, completeAppointment);
router.put('/:id/payment', authenticateToken, updateAppointmentPayment);
router.put('/:id/notes', authenticateToken, updateAppointmentBarberNotes);
router.put('/:id/no-show', authenticateToken, markNoShowAppointment);
router.post('/:id/propose-advance', authenticateToken, proposeAdvanceAppointment);

// Día libre de barbero
router.post('/day-off', authenticateToken, createBarberDayOff);

// Salida temprana de barbero
router.post('/leave-early', authenticateToken, createBarberLeaveEarly);

// Eliminar historial de citas de un cliente
// Coincide con frontend: appointmentApi.deleteHistory -> /appointments/history/:clientId
router.delete('/history/:clientId', authenticateToken, deleteAppointmentsByClientAndStatus);

// Eliminar historial (permanente) de un barbero (solo días anteriores)
router.delete('/history/barber/:barberId', authenticateToken, deleteBarberAppointmentsHistory);

// Eliminar una cita específica por id (solo admin/owner; usado para "citas fantasma")
router.delete('/:id', authenticateToken, deleteAppointmentById);

export default router;
