import express from 'express';
import pool from '../db/connection.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Get appointments for current user (client, barber, owner)
router.get('/my', authenticateToken, async (req, res) => {
  try {
    let query;
    let params = [];
    
    if (req.user.role === 'client') {
      // Clients see their own appointments, excluding las marcadas como ocultas
      query = `
        SELECT a.*, 
          bs.personal_name as service_name,
          bs.price_by_barber as service_price,
          bs.duration_by_barber as service_duration,
          ms.name as master_service_name,
          ms.base_price as master_service_price,
          ms.base_duration_minutes as master_service_duration,
          u.name as barber_name,
          s.name as shop_name
        FROM appointments a
        JOIN barberservices bs ON a.barber_service_id = bs.barber_service_id
        LEFT JOIN masterservices ms ON bs.master_service_id = ms.master_service_id
        JOIN users u ON a.barber_id = u.user_id
        JOIN barbershops s ON a.shop_id = s.shop_id
        WHERE a.client_id = $1
          AND COALESCE(a.hidden_for_client, FALSE) = FALSE
        ORDER BY a.start_time DESC
      `;
      params = [req.user.userId];
    } else if (req.user.role === 'barber') {
      // Barbers see appointments where they are the barber
      query = `
        SELECT a.*, 
          bs.personal_name as service_name,
          bs.price_by_barber as service_price,
          bs.duration_by_barber as service_duration,
          ms.name as master_service_name,
          ms.base_price as master_service_price,
          ms.base_duration_minutes as master_service_duration,
          c.name as client_name,
          c.phone as client_phone,
          s.name as shop_name
        FROM appointments a
        JOIN barberservices bs ON a.barber_service_id = bs.barber_service_id
        LEFT JOIN masterservices ms ON bs.master_service_id = ms.master_service_id
        JOIN users c ON a.client_id = c.user_id
        JOIN barbershops s ON a.shop_id = s.shop_id
        WHERE a.barber_id = $1
        ORDER BY a.start_time DESC
      `;
      params = [req.user.userId];
    } else if (req.user.role === 'owner') {
      // Owners see appointments for their shops
      query = `
        SELECT a.*, 
          bs.personal_name as service_name,
          bs.price_by_barber as service_price,
          bs.duration_by_barber as service_duration,
          ms.name as master_service_name,
          ms.base_price as master_service_price,
          ms.base_duration_minutes as master_service_duration,
          c.name as client_name,
          c.phone as client_phone,
          b.name as barber_name,
          s.name as shop_name
        FROM appointments a
        JOIN barberservices bs ON a.barber_service_id = bs.barber_service_id
        LEFT JOIN masterservices ms ON bs.master_service_id = ms.master_service_id
        JOIN users c ON a.client_id = c.user_id
        JOIN users b ON a.barber_id = b.user_id
        JOIN barbershops s ON a.shop_id = s.shop_id
        WHERE s.owner_id = $1
        ORDER BY a.start_time DESC
      `;
      params = [req.user.userId];
    }
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching appointments:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get appointments for a specific shop (owner only)
router.get('/shop/:shopId', authenticateToken, authorizeRoles('owner'), async (req, res) => {
  const shopId = req.params.shopId;
  
  try {
    // Check if user is the owner of this shop
    const shopCheck = await pool.query(
      'SELECT * FROM barbershops WHERE shop_id = $1 AND owner_id = $2',
      [shopId, req.user.userId]
    );
    
    if (shopCheck.rows.length === 0) {
      return res.status(403).json({ message: 'You do not own this shop' });
    }
    
    const result = await pool.query(`
      SELECT a.*, 
        bs.personal_name as service_name,
        bs.price_by_barber as service_price,
        bs.duration_by_barber as service_duration,
        ms.name as master_service_name,
        ms.base_price as master_service_price,
        ms.base_duration_minutes as master_service_duration,
        c.name as client_name,
        c.phone as client_phone,
        b.name as barber_name
      FROM appointments a
      JOIN barberservices bs ON a.barber_service_id = bs.barber_service_id
      LEFT JOIN masterservices ms ON bs.master_service_id = ms.master_service_id
      JOIN users c ON a.client_id = c.user_id
      JOIN users b ON a.barber_id = b.user_id
      WHERE a.shop_id = $1
      ORDER BY a.start_time DESC
    `, [shopId]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching shop appointments:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a new appointment (client only)
router.post('/', authenticateToken, authorizeRoles('client'), async (req, res) => {
  const { shopId, barberId, barberServiceId, startTime, notes } = req.body;
  
  try {
    // Get service details to calculate end time and price
    const serviceResult = await pool.query(`
      SELECT bs.*, ms.base_duration_minutes, ms.base_price
      FROM barberservices bs
      LEFT JOIN masterservices ms ON bs.master_service_id = ms.master_service_id
      WHERE bs.barber_service_id = $1
    `, [barberServiceId]);
    
    if (serviceResult.rows.length === 0) {
      return res.status(404).json({ message: 'Service not found' });
    }
    
    const service = serviceResult.rows[0];
    
    // Calculate duration and price
    const durationMinutes = service.duration_by_barber || service.base_duration_minutes;
    const price = service.price_by_barber || service.base_price;
    
    // Calculate end time
    const startDate = new Date(startTime);
    const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
    
    // Get client phone
    const clientResult = await pool.query(
      'SELECT phone FROM users WHERE user_id = $1',
      [req.user.userId]
    );
    
    const clientPhone = clientResult.rows[0]?.phone;
    
    // Create appointment
    const result = await pool.query(`
      INSERT INTO appointments 
      (client_id, shop_id, barber_id, barber_service_id, start_time, end_time, 
       status, notes_client, price_at_booking, client_phone_at_booking)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [
      req.user.userId, shopId, barberId, barberServiceId, 
      startDate.toISOString(), endDate.toISOString(), 
      'confirmed', notes, price, clientPhone
    ]);
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating appointment:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update appointment status (barber, owner)
router.put('/:id/status', authenticateToken, authorizeRoles('barber', 'owner'), async (req, res) => {
  const { status } = req.body;
  const appointmentId = req.params.id;
  
  try {
    // Check if valid status
    const validStatuses = ['confirmed', 'completed', 'cancelled_by_barber', 'cancelled_by_owner', 'no_show'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    
    // Check authorization
    let authorized = false;
    
    if (req.user.role === 'barber') {
      // Check if barber is assigned to this appointment
      const apptCheck = await pool.query(
        'SELECT * FROM appointments WHERE appointment_id = $1 AND barber_id = $2',
        [appointmentId, req.user.userId]
      );
      authorized = apptCheck.rows.length > 0;
    } else if (req.user.role === 'owner') {
      // Check if appointment is in owner's shop
      const apptCheck = await pool.query(`
        SELECT a.* FROM appointments a
        JOIN barbershops s ON a.shop_id = s.shop_id
        WHERE a.appointment_id = $1 AND s.owner_id = $2
      `, [appointmentId, req.user.userId]);
      authorized = apptCheck.rows.length > 0;
    }
    
    if (!authorized) {
      return res.status(403).json({ message: 'Not authorized to update this appointment' });
    }
    
    // Update appointment
    let query = 'UPDATE appointments SET status = $1';
    const params = [status];
    
    // If marking as completed, set actual end time
    if (status === 'completed') {
      query += ', end_time = NOW()';
    }
    
    query += ' WHERE appointment_id = $2 RETURNING *';
    params.push(appointmentId);
    
    const result = await pool.query(query, params);
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating appointment status:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Cancel appointment (client only)
router.put('/:id/cancel', authenticateToken, authorizeRoles('client'), async (req, res) => {
  const appointmentId = req.params.id;
  
  try {
    // Check if appointment belongs to client
    const apptCheck = await pool.query(
      'SELECT * FROM appointments WHERE appointment_id = $1 AND client_id = $2',
      [appointmentId, req.user.userId]
    );
    
    if (apptCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Not authorized to cancel this appointment' });
    }
    
    // Check if appointment is in the future
    const appt = apptCheck.rows[0];
    const apptTime = new Date(appt.start_time);
    const now = new Date();
    
    if (apptTime < now) {
      return res.status(400).json({ message: 'Cannot cancel past appointments' });
    }
    
    // Update appointment
    const result = await pool.query(
      'UPDATE appointments SET status = $1 WHERE appointment_id = $2 RETURNING *',
      ['cancelled_by_client', appointmentId]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error cancelling appointment:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add barber notes to appointment (barber only)
router.put('/:id/notes', authenticateToken, authorizeRoles('barber'), async (req, res) => {
  const { notes } = req.body;
  const appointmentId = req.params.id;
  
  try {
    // Check if barber is assigned to this appointment
    const apptCheck = await pool.query(
      'SELECT * FROM appointments WHERE appointment_id = $1 AND barber_id = $2',
      [appointmentId, req.user.userId]
    );
    
    if (apptCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Not authorized to update this appointment' });
    }
    
    // Update appointment
    const result = await pool.query(
      'UPDATE appointments SET notes_barber = $1 WHERE appointment_id = $2 RETURNING *',
      [notes, appointmentId]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating appointment notes:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get available time slots for a barber on a specific date
router.get('/slots/:barberId/:date', async (req, res) => {
  const { barberId, date } = req.params;
  
  try {
    // Get barber's availability for the day of week
    const dayOfWeek = new Date(date).getDay();
    const dayKey = ['D', 'L', 'M', 'X', 'J', 'V', 'S'][dayOfWeek];
    
    const availabilityResult = await pool.query(
      'SELECT * FROM barberavailability WHERE barber_id = $1 AND day_of_week = $2',
      [barberId, dayKey]
    );
    
    if (availabilityResult.rows.length === 0) {
      return res.json({ available: false, message: 'Barber is not available on this day', slots: [] });
    }
    
    const availability = availabilityResult.rows[0];
    
    // Get barber's appointments for the date
    const appointmentsResult = await pool.query(`
      SELECT a.*, bs.duration_by_barber, ms.base_duration_minutes
      FROM appointments a
      JOIN barberservices bs ON a.barber_service_id = bs.barber_service_id
      LEFT JOIN masterservices ms ON bs.master_service_id = ms.master_service_id
      WHERE a.barber_id = $1 
      AND DATE(a.start_time) = $2
      AND a.status NOT LIKE 'cancelled%'
    `, [barberId, date]);
    
    const appointments = appointmentsResult.rows;
    
    // Generate time slots
    const slots = generateTimeSlots(
      availability.start_time_local,
      availability.end_time_local,
      appointments,
      date
    );
    
    res.json({
      available: true,
      slots
    });
  } catch (error) {
    console.error('Error getting available slots:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Helper function to generate available time slots
function generateTimeSlots(startTime, endTime, appointments, date) {
  const slots = [];
  const slotDuration = 15; // minutes
  
  // Parse start and end times
  const [startHour, startMinute] = startTime.split(':').map(Number);
  const [endHour, endMinute] = endTime.split(':').map(Number);
  
  // Create Date objects for start and end times
  const dateObj = new Date(date);
  const startDate = new Date(dateObj);
  startDate.setHours(startHour, startMinute, 0, 0);
  
  const endDate = new Date(dateObj);
  endDate.setHours(endHour, endMinute, 0, 0);
  
  // Current time
  const now = new Date();
  
  // Generate slots
  let currentSlot = new Date(startDate);
  
  while (currentSlot < endDate) {
    // Skip slots in the past
    if (dateObj.toDateString() === now.toDateString() && currentSlot < now) {
      currentSlot = new Date(currentSlot.getTime() + slotDuration * 60000);
      continue;
    }
    
    // Check if slot conflicts with any appointment
    let isAvailable = true;
    
    for (const appt of appointments) {
      const apptStart = new Date(appt.start_time);
      const apptEnd = new Date(appt.end_time);
      
      // If slot starts during an appointment, it's not available
      if (currentSlot >= apptStart && currentSlot < apptEnd) {
        isAvailable = false;
        break;
      }
    }
    
    if (isAvailable) {
      slots.push({
        time: currentSlot.toISOString(),
        display: currentSlot.toLocaleTimeString('en-US', { 
          hour: '2-digit', 
          minute: '2-digit',
          hour12: true 
        })
      });
    }
    
    // Move to next slot
    currentSlot = new Date(currentSlot.getTime() + slotDuration * 60000);
  }
  
  return slots;
}

// Endpoints para manejar documentos e imágenes relacionadas con citas

// Añadir documento o imagen a una cita
router.post('/:id/attachments', authenticateToken, async (req, res) => {
  const { fileUrl, fileType, description } = req.body;
  const appointmentId = req.params.id;
  
  try {
    // Verificar que la cita existe y que el usuario tiene permiso
    const appointmentCheck = await pool.query(
      `SELECT a.*, c.user_id as client_id, b.user_id as barber_id, s.owner_id 
       FROM appointments a
       JOIN users c ON a.client_id = c.user_id
       JOIN users b ON a.barber_id = b.user_id
       JOIN barbershops s ON a.shop_id = s.shop_id
       WHERE a.appointment_id = $1`,
      [appointmentId]
    );
    
    if (appointmentCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Cita no encontrada' });
    }
    
    const appointment = appointmentCheck.rows[0];
    
    // Verificar que el usuario tiene permiso para añadir archivos a esta cita
    const isAuthorized = 
      req.user.userId === appointment.client_id || // Cliente de la cita
      req.user.userId === appointment.barber_id || // Barbero de la cita
      req.user.userId === appointment.owner_id;    // Dueño de la barbería
    
    if (!isAuthorized) {
      return res.status(403).json({ message: 'No está autorizado para añadir archivos a esta cita' });
    }
    
    // Añadir el documento a la base de datos
    const result = await pool.query(
      `INSERT INTO appointment_attachments 
       (appointment_id, file_url, file_type, description, uploaded_by) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
      [appointmentId, fileUrl, fileType, description, req.user.userId]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al añadir archivo a la cita:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// Obtener todos los archivos adjuntos de una cita
router.get('/:id/attachments', authenticateToken, async (req, res) => {
  const appointmentId = req.params.id;
  
  try {
    // Verificar que la cita existe y que el usuario tiene permiso
    const appointmentCheck = await pool.query(
      `SELECT a.*, c.user_id as client_id, b.user_id as barber_id, s.owner_id 
       FROM appointments a
       JOIN users c ON a.client_id = c.user_id
       JOIN users b ON a.barber_id = b.user_id
       JOIN barbershops s ON a.shop_id = s.shop_id
       WHERE a.appointment_id = $1`,
      [appointmentId]
    );
    
    if (appointmentCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Cita no encontrada' });
    }
    
    const appointment = appointmentCheck.rows[0];
    
    // Verificar que el usuario tiene permiso para ver archivos de esta cita
    const isAuthorized = 
      req.user.userId === appointment.client_id || // Cliente de la cita
      req.user.userId === appointment.barber_id || // Barbero de la cita
      req.user.userId === appointment.owner_id;    // Dueño de la barbería
    
    if (!isAuthorized) {
      return res.status(403).json({ message: 'No está autorizado para ver archivos de esta cita' });
    }
    
    // Obtener todos los archivos adjuntos
    const result = await pool.query(
      `SELECT aa.*, u.name as uploaded_by_name 
       FROM appointment_attachments aa
       JOIN users u ON aa.uploaded_by = u.user_id
       WHERE aa.appointment_id = $1
       ORDER BY aa.created_at DESC`,
      [appointmentId]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener archivos de la cita:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// Eliminar un archivo adjunto de una cita
router.delete('/:appointmentId/attachments/:attachmentId', authenticateToken, async (req, res) => {
  const { appointmentId, attachmentId } = req.params;
  
  try {
    // Verificar que el archivo existe y pertenece a la cita indicada
    const attachmentCheck = await pool.query(
      `SELECT aa.*, a.client_id, a.barber_id, s.owner_id 
       FROM appointment_attachments aa
       JOIN appointments a ON aa.appointment_id = a.appointment_id
       JOIN barbershops s ON a.shop_id = s.shop_id
       WHERE aa.attachment_id = $1 AND aa.appointment_id = $2`,
      [attachmentId, appointmentId]
    );
    
    if (attachmentCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Archivo adjunto no encontrado' });
    }
    
    const attachment = attachmentCheck.rows[0];
    
    // Verificar que el usuario tiene permiso para eliminar este archivo
    const isAuthorized = 
      req.user.userId === attachment.uploaded_by || // Quien subió el archivo
      req.user.userId === attachment.client_id ||   // Cliente de la cita
      req.user.userId === attachment.barber_id ||   // Barbero de la cita
      req.user.userId === attachment.owner_id;      // Dueño de la barbería
    
    if (!isAuthorized) {
      return res.status(403).json({ message: 'No está autorizado para eliminar este archivo' });
    }
    
    // Si el archivo está almacenado localmente, eliminarlo del sistema de archivos
    const fileUrl = attachment.file_url;
    if (fileUrl && fileUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, '../../../', fileUrl);
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error('Error al eliminar archivo físico:', err);
          // Continuamos con la eliminación del registro aunque falle la eliminación del archivo
        } else {
          console.log(`Archivo físico eliminado: ${filePath}`);
        }
      });
    }
    
    // Eliminar el registro de la base de datos
    await pool.query(
      'DELETE FROM appointment_attachments WHERE attachment_id = $1',
      [attachmentId]
    );
    
    res.json({
      success: true,
      message: 'Archivo eliminado correctamente',
      deletedAttachment: {
        id: attachment.attachment_id,
        fileUrl: attachment.file_url,
        fileType: attachment.file_type
      }
    });
  } catch (error) {
    console.error('Error al eliminar archivo de la cita:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// Añadir imágenes "antes y después" para una cita (solo barbero)
router.post('/:id/before-after', authenticateToken, authorizeRoles('barber'), async (req, res) => {
  const { beforeImageUrl, afterImageUrl, description } = req.body;
  const appointmentId = req.params.id;
  
  try {
    // Verificar que la cita existe y pertenece a este barbero
    const appointmentCheck = await pool.query(
      'SELECT * FROM appointments WHERE appointment_id = $1 AND barber_id = $2',
      [appointmentId, req.user.userId]
    );
    
    if (appointmentCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Cita no encontrada o no es su cita' });
    }
    
    // Verificar si ya existe un registro de antes/después para esta cita
    const existingCheck = await pool.query(
      'SELECT * FROM appointment_before_after WHERE appointment_id = $1',
      [appointmentId]
    );
    
    let result;
    
    if (existingCheck.rows.length > 0) {
      // Actualizar el registro existente
      const existingRecord = existingCheck.rows[0];
      
      // Si hay nuevas imágenes, eliminar las anteriores si eran locales
      if (beforeImageUrl && beforeImageUrl !== existingRecord.before_image_url && existingRecord.before_image_url && existingRecord.before_image_url.startsWith('/uploads/')) {
        const filePath = path.join(__dirname, '../../../', existingRecord.before_image_url);
        fs.unlink(filePath, err => {
          if (err) console.error('Error al eliminar imagen anterior:', err);
          else console.log(`Imagen anterior eliminada: ${filePath}`);
        });
      }
      
      if (afterImageUrl && afterImageUrl !== existingRecord.after_image_url && existingRecord.after_image_url && existingRecord.after_image_url.startsWith('/uploads/')) {
        const filePath = path.join(__dirname, '../../../', existingRecord.after_image_url);
        fs.unlink(filePath, err => {
          if (err) console.error('Error al eliminar imagen anterior:', err);
          else console.log(`Imagen anterior eliminada: ${filePath}`);
        });
      }
      
      // Actualizar el registro
      result = await pool.query(
        `UPDATE appointment_before_after 
         SET before_image_url = COALESCE($1, before_image_url),
             after_image_url = COALESCE($2, after_image_url),
             description = COALESCE($3, description),
             updated_at = NOW()
         WHERE appointment_id = $4
         RETURNING *`,
        [beforeImageUrl || existingRecord.before_image_url, 
         afterImageUrl || existingRecord.after_image_url, 
         description || existingRecord.description, 
         appointmentId]
      );
    } else {
      // Crear un nuevo registro
      result = await pool.query(
        `INSERT INTO appointment_before_after 
         (appointment_id, before_image_url, after_image_url, description) 
         VALUES ($1, $2, $3, $4) 
         RETURNING *`,
        [appointmentId, beforeImageUrl, afterImageUrl, description]
      );
    }
    
    res.json({
      success: true,
      beforeAfter: result.rows[0],
      message: existingCheck.rows.length > 0 ? 'Imágenes antes/después actualizadas' : 'Imágenes antes/después añadidas'
    });
  } catch (error) {
    console.error('Error al guardar imágenes antes/después:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// Obtener imágenes "antes y después" de una cita
router.get('/:id/before-after', authenticateToken, async (req, res) => {
  const appointmentId = req.params.id;
  
  try {
    // Verificar que la cita existe y que el usuario tiene permiso
    const appointmentCheck = await pool.query(
      `SELECT a.*, c.user_id as client_id, b.user_id as barber_id, s.owner_id 
       FROM appointments a
       JOIN users c ON a.client_id = c.user_id
       JOIN users b ON a.barber_id = b.user_id
       JOIN barbershops s ON a.shop_id = s.shop_id
       WHERE a.appointment_id = $1`,
      [appointmentId]
    );
    
    if (appointmentCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Cita no encontrada' });
    }
    
    const appointment = appointmentCheck.rows[0];
    
    // Verificar que el usuario tiene permiso para ver estas imágenes
    const isAuthorized = 
      req.user.userId === appointment.client_id || // Cliente de la cita
      req.user.userId === appointment.barber_id || // Barbero de la cita
      req.user.userId === appointment.owner_id;    // Dueño de la barbería
    
    if (!isAuthorized) {
      return res.status(403).json({ message: 'No está autorizado para ver estas imágenes' });
    }
    
    // Obtener las imágenes
    const result = await pool.query(
      'SELECT * FROM appointment_before_after WHERE appointment_id = $1',
      [appointmentId]
    );
    
    if (result.rows.length === 0) {
      return res.json({
        success: true,
        exists: false,
        message: 'No hay imágenes antes/después para esta cita'
      });
    }
    
    res.json({
      success: true,
      exists: true,
      beforeAfter: result.rows[0]
    });
  } catch (error) {
    console.error('Error al obtener imágenes antes/después:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

export default router;