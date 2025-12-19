import express from 'express';
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
router.post('/', createAppointment);
router.put('/:id', updateAppointment);
router.put('/:id/cancel', cancelAppointment);
router.put('/:id/complete', completeAppointment);
router.put('/:id/no-show', markNoShowAppointment);
router.post('/:id/propose-advance', proposeAdvanceAppointment);

// Día libre de barbero
router.post('/day-off', createBarberDayOff);

// Salida temprana de barbero
router.post('/leave-early', createBarberLeaveEarly);

// Eliminar historial de citas de un cliente
// Coincide con frontend: appointmentApi.deleteHistory -> /appointments/history/:clientId
router.delete('/history/:clientId', deleteAppointmentsByClientAndStatus);

// Eliminar historial (permanente) de un barbero (solo días anteriores)
router.delete('/history/barber/:barberId', deleteBarberAppointmentsHistory);

// Eliminar una cita específica por id (solo admin/owner; usado para "citas fantasma")
router.delete('/:id', deleteAppointmentById);

export default router;
