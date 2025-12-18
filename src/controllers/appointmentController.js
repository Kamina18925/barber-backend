import pool from '../db/connection.js';
import { getOrCreateClientBarberConversation } from './chatController.js';

const normalizeRole = (role) => String(role || '').toLowerCase();

const DEFAULT_TIMEZONE_OFFSET = process.env.APP_TZ_OFFSET || '-04:00';

const normalizeAppointmentDateInput = (input) => {
  if (input instanceof Date) {
    const ms = input.getTime();
    return Number.isNaN(ms) ? null : input.toISOString();
  }

  if (typeof input === 'number') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  if (typeof input !== 'string') return null;

  const s = input.trim();
  if (!s) return null;

  const hasExplicitOffset = /Z$|[+-]\d{2}:\d{2}$/.test(s);
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const isNaiveIsoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s);

  if (hasExplicitOffset) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  if (isDateOnly) {
    const d = new Date(`${s}T00:00:00${DEFAULT_TIMEZONE_OFFSET}`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  if (isNaiveIsoDateTime) {
    const d = new Date(`${s}${DEFAULT_TIMEZONE_OFFSET}`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const canUserDeleteSingleAppointment = ({ requesterId, requesterRole }) => {
  if (requesterId == null) return false;
  const role = normalizeRole(requesterRole);
  if (role.includes('admin')) return true;
  if (role.includes('owner')) return true;
  return false;
};

const canUserDeleteBarberHistory = async ({ requesterId, requesterRole, barberId }) => {
  if (requesterId == null) return false;
  const role = normalizeRole(requesterRole);

  // Admin siempre
  if (role.includes('admin')) return true;

  // Dueño: solo si el barbero pertenece a alguna barbería del dueño
  if (role.includes('owner')) {
    const res = await pool.query(
      `SELECT 1
       FROM users b
       JOIN barber_shops bs ON bs.id = b.shop_id
       WHERE b.id = $1 AND bs.owner_id = $2
       LIMIT 1`,
      [barberId, requesterId]
    );
    return res.rows.length > 0;
  }

  // Barbero: solo a sí mismo y si tiene permiso
  if (role.includes('barber')) {
    if (String(requesterId) !== String(barberId)) return false;
    const res = await pool.query(
      'SELECT can_delete_history FROM users WHERE id = $1',
      [barberId]
    );
    return Boolean(res.rows[0]?.can_delete_history);
  }

  return false;
};

// Obtener todas las citas
export const getAllAppointments = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        a.id,
        a.uuid,
        a.date,
        a.hidden_for_client,
        a.status,
        a.notes,
        a.shop_id,
        a.barber_id,
        a.client_id,
        a.service_id,
        c.name as client_name,
        b.name as barber_name,
        s.name as service_name,
        bs.name as shop_name
      FROM appointments a
      LEFT JOIN users c ON a.client_id = c.id
      LEFT JOIN users b ON a.barber_id = b.id
      LEFT JOIN services s ON a.service_id = s.id
      LEFT JOIN barber_shops bs ON a.shop_id = bs.id
      ORDER BY a.date DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener citas:', error);
    res.status(500).json({ message: 'Error del servidor al obtener citas' });
  }
};

// Eliminación permanente de historial de citas de un barbero (solo días anteriores)
// Modos:
// - cancelled: status LIKE 'cancelled%'
// - past: status = 'completed'
// - no_show: status = 'no_show'
// - all: cualquiera de los anteriores
// - all_any_status: cualquier status
export const deleteBarberAppointmentsHistory = async (req, res) => {
  const client = await pool.connect();
  try {
    const { barberId } = req.params;
    const { mode, requesterId, requesterRole } = req.body || {};

    if (!barberId) {
      return res.status(400).json({ message: 'barberId es requerido' });
    }

    const allowed = await canUserDeleteBarberHistory({ requesterId, requesterRole, barberId });
    if (!allowed) {
      return res.status(403).json({ message: 'No autorizado para eliminar historial de este barbero' });
    }

    const finalMode = String(mode || '').toLowerCase();
    const validModes = ['cancelled', 'past', 'no_show', 'all', 'all_any_status'];
    if (!validModes.includes(finalMode)) {
      return res.status(400).json({ message: 'mode inválido. Usa: cancelled, past, no_show, all, all_any_status' });
    }

    // Solo días anteriores: date < hoy (00:00)
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    await client.query('BEGIN');

    // 1) Buscar IDs objetivo
    const params = [barberId, todayStart];
    let statusSql = '';

    if (finalMode === 'cancelled') {
      statusSql = "AND (a.status = 'cancelled' OR a.status LIKE 'cancelled%')";
    } else if (finalMode === 'past') {
      statusSql = "AND a.status = 'completed'";
    } else if (finalMode === 'no_show') {
      statusSql = "AND a.status = 'no_show'";
    } else if (finalMode === 'all') {
      statusSql = "AND (a.status = 'completed' OR a.status = 'no_show' OR a.status = 'cancelled' OR a.status LIKE 'cancelled%')";
    } else if (finalMode === 'all_any_status') {
      statusSql = '';
    }

    const apptRes = await client.query(
      `SELECT a.id
       FROM appointments a
       WHERE a.barber_id = $1
         AND a.date < $2
         ${statusSql}`,
      params
    );

    const appointmentIds = apptRes.rows.map(r => r.id);
    if (appointmentIds.length === 0) {
      await client.query('COMMIT');
      return res.json({ deleted: 0 });
    }

    // 2) Borrar dependencias antes de borrar appointments
    // appointment_notes
    await client.query('DELETE FROM appointment_notes WHERE appointment_id = ANY($1::int[])', [appointmentIds]);

    // appointment_extras
    await client.query('DELETE FROM appointment_extras WHERE appointment_id = ANY($1::int[])', [appointmentIds]);

    // appointment_status_history
    await client.query('DELETE FROM appointment_status_history WHERE appointment_id = ANY($1::int[])', [appointmentIds]);

    // conversations/messages: eliminar conversaciones ligadas a appointment_id (messages tiene ON DELETE CASCADE)
    await client.query('DELETE FROM conversations WHERE appointment_id = ANY($1::int[])', [appointmentIds]);

    // notifications relacionadas a la propuesta de adelanto: se guardan con payload->appointmentId
    // No hay FK, pero si no se borran, reaparecen como notificaciones históricas.
    await client.query(
      `DELETE FROM notifications
       WHERE (payload->>'appointmentId')::int = ANY($1::int[])`,
      [appointmentIds]
    );

    // 3) Borrar appointments
    const delRes = await client.query('DELETE FROM appointments WHERE id = ANY($1::int[])', [appointmentIds]);

    await client.query('COMMIT');
    return res.json({ deleted: delRes.rowCount || appointmentIds.length });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al eliminar historial de citas del barbero:', error);
    return res.status(500).json({ message: 'Error del servidor al eliminar historial de citas del barbero' });
  } finally {
    client.release();
  }
};

// Eliminación PERMANENTE de una cita por id (para casos de "cita fantasma")
// Nota: esto elimina también dependencias (notas, extras, status_history, conversaciones y notificaciones relacionadas).
export const deleteAppointmentById = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { requesterId, requesterRole } = req.body || {};

    if (!id) {
      return res.status(400).json({ message: 'id es requerido' });
    }

    const allowed = canUserDeleteSingleAppointment({ requesterId, requesterRole });
    if (!allowed) {
      return res.status(403).json({ message: 'No autorizado para eliminar citas' });
    }

    await client.query('BEGIN');

    const apptRes = await client.query('SELECT id FROM appointments WHERE id = $1', [id]);
    if (apptRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Cita no encontrada' });
    }

    const appointmentId = Number(id);
    if (Number.isNaN(appointmentId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'id inválido' });
    }

    // Borrar dependencias antes de borrar appointment (por FK conversations -> appointments)
    await client.query('DELETE FROM appointment_notes WHERE appointment_id = $1', [appointmentId]);
    await client.query('DELETE FROM appointment_extras WHERE appointment_id = $1', [appointmentId]);
    await client.query('DELETE FROM appointment_status_history WHERE appointment_id = $1', [appointmentId]);

    // conversations/messages: messages tiene FK a conversations con ON DELETE CASCADE
    await client.query('DELETE FROM conversations WHERE appointment_id = $1', [appointmentId]);

    // notifications relacionadas a la propuesta de adelanto: payload->appointmentId
    await client.query(
      `DELETE FROM notifications
       WHERE (payload->>'appointmentId')::int = $1`,
      [appointmentId]
    );

    const delRes = await client.query('DELETE FROM appointments WHERE id = $1', [appointmentId]);

    await client.query('COMMIT');
    return res.json({ deleted: delRes.rowCount || 0, id: appointmentId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al eliminar cita por id:', error);
    return res.status(500).json({ message: 'Error del servidor al eliminar la cita' });
  } finally {
    client.release();
  }
};

// Obtener citas por cliente
export const getAppointmentsByClient = async (req, res) => {
  try {
    const { clientId } = req.params;
    
    const result = await pool.query(`
      SELECT 
        a.id,
        a.uuid,
        a.date,
        a.hidden_for_client,
        a.status,
        a.notes,
        a.shop_id,
        a.barber_id,
        a.client_id,
        a.service_id,
        b.name as barber_name,
        ms.name as service_name,
        bs.name as shop_name
      FROM appointments a
      LEFT JOIN users b ON a.barber_id = b.id
      LEFT JOIN services ms ON a.service_id = ms.id
      LEFT JOIN barber_shops bs ON a.shop_id = bs.id
      WHERE a.client_id = $1
      ORDER BY a.date DESC
    `, [clientId]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener citas por cliente:', error);
    res.status(500).json({ message: 'Error del servidor al obtener citas por cliente' });
  }
};

// Obtener citas por barbero
export const getAppointmentsByBarber = async (req, res) => {
  try {
    const { barberId } = req.params;
    
    const result = await pool.query(`
      SELECT a.*,
             c.nombre as client_name,
             s.nombre as service_name,
             bs.nombre as shop_name
      FROM appointments a
      LEFT JOIN users c ON a.client_id = c.id
      LEFT JOIN services s ON a.service_id = s.id
      LEFT JOIN barber_shops bs ON a.shop_id = bs.id
      WHERE a.barber_id = $1
      ORDER BY a.fecha DESC, a.hora
    `, [barberId]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener citas por barbero:', error);
    res.status(500).json({ message: 'Error del servidor al obtener citas por barbero' });
  }
};

// Obtener citas por tienda
export const getAppointmentsByShop = async (req, res) => {
  try {
    const { shopId } = req.params;
    
    const result = await pool.query(`
      SELECT a.*,
             c.nombre as client_name,
             b.nombre as barber_name,
             s.nombre as service_name
      FROM appointments a
      LEFT JOIN users c ON a.client_id = c.id
      LEFT JOIN users b ON a.barber_id = b.id
      LEFT JOIN services s ON a.service_id = s.id
      WHERE a.shop_id = $1
      ORDER BY a.fecha DESC, a.hora
    `, [shopId]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener citas por tienda:', error);
    res.status(500).json({ message: 'Error del servidor al obtener citas por tienda' });
  }
};

// Obtener cita por ID
export const getAppointmentById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT a.*,
             c.nombre as client_name,
             b.nombre as barber_name,
             s.nombre as service_name,
             bs.nombre as shop_name
      FROM appointments a
      LEFT JOIN users c ON a.client_id = c.id
      LEFT JOIN users b ON a.barber_id = b.id
      LEFT JOIN services s ON a.service_id = s.id
      LEFT JOIN barber_shops bs ON a.shop_id = bs.id
      WHERE a.id = $1 OR a.uuid = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Cita no encontrada' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error al obtener cita por ID:', error);
    res.status(500).json({ message: 'Error del servidor al obtener cita' });
  }
};

// Crear una nueva cita (ajustada al esquema actual de appointments)
export const createAppointment = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      // Fecha/hora: el frontend envía startTime (ISO) o date
      date,
      startTime,
      start_time,
      // IDs en camelCase o snake_case
      clientId,
      client_id,
      barberId,
      barber_id,
      shopId,
      shop_id,
      serviceId,
      service_id,
      // Estado y notas
      status,
      estado,
      notes,
      notas
    } = req.body;

    const finalDate = date || startTime || start_time;
    const finalClientId = clientId !== undefined ? clientId : client_id;
    const finalBarberId = barberId !== undefined ? barberId : barber_id;
    const finalShopId = shopId !== undefined ? shopId : shop_id;
    const finalServiceId = serviceId !== undefined ? serviceId : service_id;
    const finalStatus = (status || estado || 'confirmed').toLowerCase();
    const finalNotes = notes || notas || null;
    const normalizedDate = normalizeAppointmentDateInput(finalDate);

    if (!finalDate || !normalizedDate || !finalClientId || !finalBarberId || !finalShopId || !finalServiceId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Datos incompletos para crear la cita' });
    }

    // Verificar que el barbero no tenga ya una cita en ese mismo instante (slot ocupado)
    const overlapCheck = await client.query(
      `SELECT id, status FROM appointments
       WHERE barber_id = $1
         AND date = $2
         AND status != 'cancelled'`,
      [finalBarberId, normalizedDate]
    );

    if (overlapCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: 'El barbero ya tiene una cita en ese horario. Por favor elige otra hora.',
      });
    }

    // Insertar la cita en la tabla appointments (esquema actual)
    const result = await client.query(
      `INSERT INTO appointments (
        date,
        status,
        notes,
        client_id,
        barber_id,
        shop_id,
        service_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, date, status, notes, client_id, barber_id, shop_id, service_id`,
      [
        normalizedDate,
        finalStatus,
        finalNotes,
        finalClientId,
        finalBarberId,
        finalShopId,
        finalServiceId
      ]
    );

    await client.query('COMMIT');

    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al crear cita:', error);

    // Si existe una constraint única en BD (barber_id, date), capturar el error de violación única
    if (error && error.code === '23505') {
      return res.status(409).json({
        message: 'El barbero ya tiene una cita en ese horario. Por favor elige otra hora.',
      });
    }

    res.status(500).json({ message: 'Error del servidor al crear cita' });
  } finally {
    client.release();
  }
};

// Proponer adelanto de cita: crea notificación + mensaje automático en el chat
export const proposeAdvanceAppointment = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { newTime } = req.body || {};

    if (!newTime) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Falta newTime en el cuerpo de la petición' });
    }

    // Verificar que la cita existe y obtener datos básicos
    const apptRes = await client.query(
      `SELECT id, date, client_id, barber_id
       FROM appointments
       WHERE id = $1`,
      [id]
    );

    if (apptRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Cita no encontrada' });
    }

    const appointment = apptRes.rows[0];

    // Crear notificación para el cliente
    const normalizedNewTime = normalizeAppointmentDateInput(newTime);
    const newTimeDate = new Date(normalizedNewTime || newTime);
    const timeLabel = newTimeDate.toLocaleTimeString('es-DO', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/Santo_Domingo',
    });

    const notifRes = await client.query(
      `INSERT INTO notifications (
         user_id,
         type,
         title,
         message,
         status,
         payload
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        appointment.client_id,
        'RESCHEDULE_PROPOSAL',
        'Propuesta de adelanto de cita',
        `Tu barbero sugiere adelantar la cita a las ${timeLabel}`,
        'PENDING',
        JSON.stringify({ appointmentId: appointment.id, newTime }),
      ]
    );

    const notification = notifRes.rows[0];

    await client.query('COMMIT');

    // Crear/obtener conversación y mensaje de sistema en una transacción aparte
    let conversationId;
    try {
      conversationId = await getOrCreateClientBarberConversation(appointment.id);
    } catch (convError) {
      console.error('Error al obtener/crear conversación para adelanto:', convError);
      // No revertimos la notificación ya creada; solo logueamos
    }

    if (conversationId) {
      try {
        await pool.query(
          `INSERT INTO messages (
             conversation_id,
             sender_id,
             receiver_id,
             text,
             is_system,
             related_action,
             related_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            conversationId,
            appointment.barber_id,
            appointment.client_id,
            `Hola, he solicitado adelantar tu cita para las ${timeLabel}. ¿Puedes confirmar?`,
            true,
            'RESCHEDULE_PROPOSAL',
            String(notification.id),
          ]
        );
      } catch (msgError) {
        console.error('Error al crear mensaje automático de adelanto:', msgError);
      }
    }

    return res.status(201).json({
      message: 'Propuesta de adelanto creada',
      notification,
      conversationId: conversationId || null,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al proponer adelanto de cita:', error);
    return res.status(500).json({ message: 'Error del servidor al proponer adelanto de cita' });
  } finally {
    client.release();
  }
};

// Marcar un día libre para un barbero (bloquea reservas ese día)
export const createBarberDayOff = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      date,          // ISO o YYYY-MM-DD
      barberId,
      barber_id,
      shopId,
      shop_id,
      notes,
      razon,
      reason,
    } = req.body || {};

    const finalBarberId = barberId !== undefined ? barberId : barber_id;
    const finalShopId = shopId !== undefined ? shopId : shop_id;
    const finalNotes = notes || razon || reason || null;

    if (!date || !finalBarberId || !finalShopId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Faltan datos para marcar el día libre (date, barberId, shopId)' });
    }

    const normalizedDate = normalizeAppointmentDateInput(date);
    if (!normalizedDate) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Fecha inválida para marcar el día libre' });
    }

    const result = await client.query(
      `INSERT INTO appointments (
        date,
        status,
        notes,
        client_id,
        barber_id,
        shop_id,
        service_id
      )
      VALUES ($1, 'day_off', $2, NULL, $3, $4, NULL)
      RETURNING id, date, status, notes, client_id, barber_id, shop_id, service_id`,
      [normalizedDate, finalNotes, finalBarberId, finalShopId]
    );

    await client.query('COMMIT');

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al marcar día libre del barbero:', error);
    return res.status(500).json({ message: 'Error del servidor al marcar día libre del barbero' });
  } finally {
    client.release();
  }
};

// Actualizar una cita
export const updateAppointment = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const {
      fecha,
      hora,
      client_id,
      barber_id,
      service_id,
      shop_id,
      estado,
      notas,
      duracion
    } = req.body;
    
    // Verificar que la cita existe
    const checkResult = await client.query('SELECT * FROM appointments WHERE id = $1', [id]);
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Cita no encontrada' });
    }
    
    // Si se cambia la fecha/hora/barbero, verificar disponibilidad
    if (fecha && hora && barber_id) {
      const disponibilidadCheck = await client.query(`
        SELECT * FROM appointments
        WHERE barber_id = $1
        AND fecha = $2
        AND hora = $3
        AND id != $4
        AND estado != 'cancelada'
      `, [barber_id, fecha, hora, id]);
      
      if (disponibilidadCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'El barbero ya tiene una cita en ese horario' });
      }
    }
    
    // Actualizar la cita
    const updateQuery = `
      UPDATE appointments 
      SET 
        fecha = COALESCE($1, fecha),
        hora = COALESCE($2, hora),
        client_id = COALESCE($3, client_id),
        barber_id = COALESCE($4, barber_id),
        service_id = COALESCE($5, service_id),
        shop_id = COALESCE($6, shop_id),
        estado = COALESCE($7, estado),
        notas = COALESCE($8, notas),
        duracion = COALESCE($9, duracion),
        updated_at = NOW()
      WHERE id = $10
      RETURNING *
    `;
    
    const result = await client.query(updateQuery, [
      fecha,
      hora,
      client_id,
      barber_id,
      service_id,
      shop_id,
      estado,
      notas,
      duracion,
      id
    ]);
    
    // Obtener información detallada de la cita
    const appointmentWithDetails = await client.query(`
      SELECT a.*,
             c.nombre as client_name,
             b.nombre as barber_name,
             s.nombre as service_name,
             bs.nombre as shop_name
      FROM appointments a
      LEFT JOIN users c ON a.client_id = c.id
      LEFT JOIN users b ON a.barber_id = b.id
      LEFT JOIN services s ON a.service_id = s.id
      LEFT JOIN barber_shops bs ON a.shop_id = bs.id
      WHERE a.id = $1
    `, [id]);
    
    await client.query('COMMIT');
    
    res.json(appointmentWithDetails.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al actualizar cita:', error);
    res.status(500).json({ message: 'Error del servidor al actualizar cita' });
  } finally {
    client.release();
  }
};

// Cancelar una cita (usando id de appointments)
export const cancelAppointment = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;

    // Verificar que la cita existe
    const checkResult = await client.query(
      'SELECT id, date, status FROM appointments WHERE id = $1',
      [id]
    );

    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Cita no encontrada' });
    }

    const appt = checkResult.rows[0];
    const status = String(appt.status || '').toLowerCase();
    const startMs = appt.date ? new Date(appt.date).getTime() : NaN;
    const isPast = Number.isNaN(startMs) ? false : startMs < Date.now();

    // No permitir cancelar citas en el pasado (aunque sigan en confirmed)
    if (isPast) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'No puedes cancelar una cita pasada.' });
    }

    // Solo permitir cancelar si está confirmada
    if (status !== 'confirmed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Solo puedes cancelar citas confirmadas.' });
    }

    // Actualizar estado a cancelada
    const result = await client.query(
      `UPDATE appointments 
       SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1
       RETURNING id, date, status, notes, client_id, barber_id, shop_id, service_id`,
      [id]
    );

    await client.query('COMMIT');

    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al cancelar cita:', error);
    res.status(500).json({ message: 'Error del servidor al cancelar cita' });
  } finally {
    client.release();
  }
};

// Marcar cita como completada
export const completeAppointment = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;

    const checkResult = await client.query('SELECT * FROM appointments WHERE id = $1', [id]);

    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Cita no encontrada' });
    }

    const result = await client.query(
      `UPDATE appointments 
       SET status = 'completed', updated_at = NOW()
       WHERE id = $1
       RETURNING id, date, status, notes, client_id, barber_id, shop_id, service_id`,
      [id]
    );

    await client.query('COMMIT');

    return res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al marcar cita como completada:', error);
    return res.status(500).json({ message: 'Error del servidor al marcar cita como completada' });
  } finally {
    client.release();
  }
};

// Marcar cita como no asistida (no_show)
export const markNoShowAppointment = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;

    const checkResult = await client.query('SELECT * FROM appointments WHERE id = $1', [id]);

    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Cita no encontrada' });
    }

    const result = await client.query(
      `UPDATE appointments 
       SET status = 'no_show', updated_at = NOW()
       WHERE id = $1
       RETURNING id, date, status, notes, client_id, barber_id, shop_id, service_id`,
      [id]
    );

    await client.query('COMMIT');

    return res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al marcar cita como no_show:', error);
    return res.status(500).json({ message: 'Error del servidor al marcar cita como no_show' });
  } finally {
    client.release();
  }
};

// "Borrar historial" de citas del cliente SIN eliminar registros en BD
// En lugar de borrar filas, marcamos las citas como ocultas para el cliente
// mediante la columna hidden_for_client (boolean) en la tabla appointments.
// El barbero y el dueño siguen viendo todas las citas.
export const deleteAppointmentsByClientAndStatus = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { clientId } = req.params;
    const keepActiveRaw = (req.body && req.body.keepActive) ?? req.query.keepActive ?? true;
    const keepActive = keepActiveRaw === true || keepActiveRaw === 'true' || keepActiveRaw === 1 || keepActiveRaw === '1';

    // Si keepActive=true (caso actual del frontend), ocultamos citas de historial:
    // - completadas/canceladas
    // - y cualquier cita en el pasado que NO esté ya cancelada/completada/no_show
    if (keepActive) {
      await client.query(
        `UPDATE appointments
         SET hidden_for_client = TRUE, updated_at = NOW()
         WHERE client_id = $1
           AND (
             status = 'completed'
             OR status = 'cancelled'
             OR status LIKE 'cancelled%'
             OR (
               (service_id IS NULL OR barber_id IS NULL OR shop_id IS NULL)
               AND (notes ILIKE '%pedido de producto%')
             )
             OR (date < NOW() AND status <> 'cancelled' AND status <> 'completed' AND status <> 'no_show' AND status NOT LIKE 'cancelled%')
           )`,
        [clientId]
      );
    } else {
      // Si en el futuro se llama con keepActive=false, ocultar todas las citas del cliente.
      await client.query(
        `UPDATE appointments
         SET hidden_for_client = TRUE, updated_at = NOW()
         WHERE client_id = $1`,
        [clientId]
      );
    }

    await client.query('COMMIT');
    return res.status(204).send();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al procesar borrado de historial de citas del cliente:', error);
    return res.status(500).json({ message: 'Error del servidor al procesar borrado de historial de citas del cliente' });
  } finally {
    client.release();
  }
};
