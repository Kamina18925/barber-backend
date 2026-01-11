import pool from '../db/connection.js';
import { getOrCreateClientBarberConversation } from './chatController.js';
import { enforceShopSubscriptionForBooking } from '../services/subscriptionService.js';
import { sendPushToUser } from '../services/fcmService.js';

const normalizeRole = (role) => String(role || '').toLowerCase();

const DEFAULT_TIMEZONE_OFFSET = process.env.APP_TZ_OFFSET || '-04:00';

const isTransientConnectionError = (error) => {
  const msg = String(error?.message || '');
  const code = String(error?.code || '');
  return (
    msg.includes('Connection terminated unexpectedly') ||
    msg.includes('Connection terminated due to connection timeout') ||
    msg.includes('terminating connection') ||
    msg.includes('ECONNRESET') ||
    msg.includes('Query read timeout') ||
    msg.includes('timeout') ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03'
  );
};

const queryWithRetry = async (text, params, queryTimeoutMs) => {
  const delaysMs = [0, 250, 1000];
  let lastError;

  for (const delay of delaysMs) {
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }

    let client;
    try {
      client = await Promise.race([
        pool.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('connect_timeout')), 7000)),
      ]);
    } catch (error) {
      lastError = error;
      if (!isTransientConnectionError(error)) throw error;
      continue;
    }

    try {
      return await client.query({
        text,
        values: params,
        ...(queryTimeoutMs != null ? { query_timeout: queryTimeoutMs } : {}),
      });
    } catch (error) {
      lastError = error;
      if (!isTransientConnectionError(error)) throw error;
    } finally {
      try {
        client.release();
      } catch {
      }
    }
  }

  throw lastError;
};

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
    const includeOrphans = String(req.query?.includeOrphans ?? req.query?.include_orphans ?? '').toLowerCase() === 'true';
    const includeArchived = String(req.query?.includeArchived ?? req.query?.include_archived ?? '').toLowerCase() === 'true';

    const where = [];
    if (!includeOrphans) where.push('bs.id IS NOT NULL AND o.id IS NOT NULL');
    if (!includeArchived) where.push('bs.deleted_at IS NULL AND o.deleted_at IS NULL');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await queryWithRetry(`
      SELECT 
        a.id,
        a.uuid,
        a.date,
        a.actual_end_time,
        a.hidden_for_client,
        COALESCE(a.client_reviewed, FALSE) as client_reviewed,
        a.status,
        a.notes,
        a.notes_barber,
        a.payment_method,
        a.payment_status,
        a.payment_marked_at,
        a.payment_marked_by,
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
      LEFT JOIN users o ON bs.owner_id = o.id
      ${whereSql}
      ORDER BY a.date DESC
    `, [], 5000);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener citas:', error);
    if (isTransientConnectionError(error)) {
      return res.json([]);
    }
    res.status(500).json({ message: 'Error del servidor al obtener citas' });
  }
};

export const updateAppointmentBarberNotes = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { notes, notesBarber, notes_barber } = req.body || {};

    const requesterId = req.user?.userId ?? req.body?.requesterId;
    const requesterRole = req.user?.role ?? req.body?.requesterRole;

    const finalNotes =
      notes !== undefined
        ? notes
        : (notesBarber !== undefined ? notesBarber : notes_barber);

    const apptRes = await client.query(
      `SELECT id, barber_id, shop_id
       FROM appointments
       WHERE id = $1`,
      [id]
    );

    if (apptRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Cita no encontrada' });
    }

    const appt = apptRes.rows[0];

    if (appt?.shop_id != null) {
      try {
        await enforceShopSubscriptionForBooking(client, appt.shop_id);
      } catch (e) {
        await client.query('ROLLBACK');
        return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
      }
    }

    const role = String(requesterRole || '').toLowerCase();
    const rid = requesterId != null ? String(requesterId) : null;

    let authorized = false;
    if (role.includes('admin')) authorized = true;
    else if (role.includes('barber')) authorized = rid != null && String(appt.barber_id) === rid;
    else if (role.includes('owner')) {
      if (rid != null) {
        const ownRes = await client.query(
          `SELECT 1
           FROM barber_shops bs
           WHERE bs.id = $1 AND bs.owner_id = $2
           LIMIT 1`,
          [appt.shop_id, rid]
        );
        authorized = ownRes.rows.length > 0;
      }
    }

    if (!authorized) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'No autorizado para actualizar notas de esta cita' });
    }

    const result = await client.query(
      `UPDATE appointments
       SET notes_barber = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING id, date, actual_end_time, status, notes, notes_barber, client_id, barber_id, shop_id, service_id, payment_method, payment_status, payment_marked_at, payment_marked_by`,
      [finalNotes ?? null, id]
    );

    await client.query('COMMIT');
    return res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al actualizar notas del barbero:', error);
    return res.status(500).json({ message: 'Error del servidor al actualizar notas del barbero' });
  } finally {
    client.release();
  }
};

export const createBarberLeaveEarly = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      startTime,
      start_time,
      date,
      time,
      barberId,
      barber_id,
      shopId,
      shop_id,
      notes,
    } = req.body || {};

    const finalBarberId = barberId !== undefined ? barberId : barber_id;
    const finalShopId = shopId !== undefined ? shopId : shop_id;

    let rawDateTime = startTime !== undefined ? startTime : start_time;
    if (!rawDateTime && date && time) {
      rawDateTime = `${String(date).trim()}T${String(time).trim()}:00`;
    }

    if (!rawDateTime || !finalBarberId || !finalShopId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Faltan datos para marcar salida temprana (startTime/date+time, barberId, shopId)' });
    }

    const normalizedDateTime = normalizeAppointmentDateInput(rawDateTime);
    if (!normalizedDateTime) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Fecha/hora inválida para salida temprana' });
    }

    try {
      await enforceShopSubscriptionForBooking(client, finalShopId);
    } catch (e) {
      await client.query('ROLLBACK');
      return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
    }

    await client.query(
      `UPDATE appointments
       SET status = 'cancelled', updated_at = NOW()
       WHERE barber_id = $1
         AND shop_id = $2
         AND status = 'leave_early'
         AND DATE(date AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santo_Domingo') = DATE($3 AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santo_Domingo')`,
      [finalBarberId, finalShopId, normalizedDateTime]
    );

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
      VALUES ($1, 'leave_early', $2, NULL, $3, $4, NULL)
      RETURNING id, date, status, notes, client_id, barber_id, shop_id, service_id`,
      [normalizedDateTime, notes || null, finalBarberId, finalShopId]
    );

    await client.query('COMMIT');
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al marcar salida temprana del barbero:', error);
    return res.status(500).json({ message: 'Error del servidor al marcar salida temprana del barbero' });
  } finally {
    client.release();
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
    const { mode } = req.body || {};

    const requesterId = req.user?.userId ?? req.body?.requesterId;
    const requesterRole = req.user?.role ?? req.body?.requesterRole;

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

    const shopRes = await client.query(
      `SELECT DISTINCT shop_id
       FROM appointments
       WHERE id = ANY($1::int[])
         AND shop_id IS NOT NULL`,
      [appointmentIds]
    );
    for (const row of shopRes.rows) {
      const shopId = row?.shop_id;
      if (shopId != null) {
        try {
          await enforceShopSubscriptionForBooking(client, shopId);
        } catch (e) {
          await client.query('ROLLBACK');
          return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
        }
      }
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
    return res.status(500).json({ message: 'Error del servidor al eliminar historial de citas' });
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
    const requesterId = req.user?.userId ?? req.body?.requesterId;
    const requesterRole = req.user?.role ?? req.body?.requesterRole;

    if (!id) {
      return res.status(400).json({ message: 'id es requerido' });
    }

    const allowed = canUserDeleteSingleAppointment({ requesterId, requesterRole });
    if (!allowed) {
      return res.status(403).json({ message: 'No autorizado para eliminar citas' });
    }

    await client.query('BEGIN');

    const apptRes = await client.query('SELECT id, shop_id FROM appointments WHERE id = $1', [id]);
    if (apptRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Cita no encontrada' });
    }

    const shopToCheck = apptRes.rows[0]?.shop_id ?? null;
    if (shopToCheck != null) {
      try {
        await enforceShopSubscriptionForBooking(client, shopToCheck);
      } catch (e) {
        await client.query('ROLLBACK');
        return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
      }
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
        a.actual_end_time,
        a.hidden_for_client,
        COALESCE(a.client_reviewed, FALSE) as client_reviewed,
        a.status,
        a.notes,
        a.notes_barber,
        a.payment_method,
        a.payment_status,
        a.payment_marked_at,
        a.payment_marked_by,
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
             c.name as client_name,
             s.name as service_name,
             bs.name as shop_name
      FROM appointments a
      LEFT JOIN users c ON a.client_id = c.id
      LEFT JOIN services s ON a.service_id = s.id
      LEFT JOIN barber_shops bs ON a.shop_id = bs.id
      WHERE a.barber_id = $1
      ORDER BY a.date DESC
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
             c.name as client_name,
             b.name as barber_name,
             s.name as service_name
      FROM appointments a
      LEFT JOIN users c ON a.client_id = c.id
      LEFT JOIN users b ON a.barber_id = b.id
      LEFT JOIN services s ON a.service_id = s.id
      WHERE a.shop_id = $1
      ORDER BY a.date DESC
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
    const isNumericId = /^[0-9]+$/.test(String(id));
    
    const result = await pool.query(
      `SELECT a.*,
              c.name as client_name,
              b.name as barber_name,
              s.name as service_name,
              bs.name as shop_name
       FROM appointments a
       LEFT JOIN users c ON a.client_id = c.id
       LEFT JOIN users b ON a.barber_id = b.id
       LEFT JOIN services s ON a.service_id = s.id
       LEFT JOIN barber_shops bs ON a.shop_id = bs.id
       WHERE ${isNumericId ? 'a.id = $1' : 'a.uuid = $1'}
      `,
      [id]
    );
    
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

    try {
      await enforceShopSubscriptionForBooking(client, finalShopId);
    } catch (e) {
      await client.query('ROLLBACK');
      return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
    }

    if (finalStatus === 'confirmed') {
      const duplicateServiceCheck = await client.query(
        `SELECT id
         FROM appointments
         WHERE client_id = $1
           AND service_id = $2
           AND status = 'confirmed'
           AND DATE(date AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santo_Domingo') = DATE($3 AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santo_Domingo')
         LIMIT 1`,
        [finalClientId, finalServiceId, normalizedDate]
      );

      if (duplicateServiceCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          message: 'Ya tienes una cita activa para este servicio hoy. Elige otro servicio o cancela la cita actual.',
        });
      }
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

    const leaveEarlyCheck = await client.query(
      `SELECT date
       FROM appointments
       WHERE barber_id = $1
         AND shop_id = $2
         AND status = 'leave_early'
         AND DATE(date AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santo_Domingo') = DATE($3 AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santo_Domingo')
       ORDER BY date DESC
       LIMIT 1`,
      [finalBarberId, finalShopId, normalizedDate]
    );

    if (leaveEarlyCheck.rows.length > 0) {
      const cutoff = leaveEarlyCheck.rows[0]?.date ? new Date(leaveEarlyCheck.rows[0].date).getTime() : NaN;
      const desired = new Date(normalizedDate).getTime();
      if (!Number.isNaN(cutoff) && !Number.isNaN(desired) && desired >= cutoff) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          message: 'El barbero se retira temprano hoy. Por favor elige otra hora.',
        });
      }
    }

    try {
      const svcRes = await client.query('SELECT duration FROM services WHERE id = $1', [finalServiceId]);
      const durationMinutes = Math.max(0, Number(svcRes.rows[0]?.duration) || 0);

      const startMs = new Date(normalizedDate).getTime();
      const startDateObj = new Date(startMs);

      const startMin = startDateObj.getHours() * 60 + startDateObj.getMinutes();
      const endMin = startMin + durationMinutes;

      const dayKeyByIndex = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
      const dayKey = dayKeyByIndex[startDateObj.getDay()] || null;
      const prevDayKey = dayKeyByIndex[(startDateObj.getDay() + 6) % 7] || null;

      if (dayKey && prevDayKey) {
        const breaksRes = await client.query(
          `SELECT day, start_time, end_time
           FROM barber_breaks
           WHERE barber_id = $1
             AND enabled = true
             AND day IN ($2, $3)`,
          [finalBarberId, dayKey, prevDayKey]
        );

        const toMinutes = (t) => {
          if (!t) return null;
          const s = String(t);
          const parts = s.split(':');
          const hh = Number(parts[0]);
          const mm = Number(parts[1] || 0);
          if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
          return (hh * 60) + mm;
        };

        const intervals = [];
        for (const row of (breaksRes.rows || [])) {
          const bStart = toMinutes(row.start_time);
          const bEnd = toMinutes(row.end_time);
          if (bStart == null || bEnd == null) continue;

          const crosses = bStart > bEnd;
          if (String(row.day) === String(dayKey)) {
            if (!crosses) {
              intervals.push([bStart, bEnd]);
            } else {
              intervals.push([bStart, 1440]);
            }
          }
          if (crosses && String(row.day) === String(prevDayKey)) {
            intervals.push([0, bEnd]);
          }
        }

        const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

        const apptIntervals = [];
        if (endMin <= 1440) {
          apptIntervals.push([startMin, endMin]);
        } else {
          apptIntervals.push([startMin, 1440]);
          apptIntervals.push([0, endMin - 1440]);
        }

        const hasConflict = intervals.some(([bStart, bEnd]) =>
          apptIntervals.some(([aStart, aEnd]) => overlaps(aStart, aEnd, bStart, bEnd))
        );

        if (hasConflict) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            message: 'El barbero está en descanso en ese horario. Por favor elige otra hora.',
          });
        }
      }
    } catch (e) {
      if (!(e && e.code === '42P01')) {
        throw e;
      }
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

    // Enviar push real (FCM) para que llegue incluso con la app cerrada.
    // Si FCM no está configurado en el servidor, sendPushToUser simplemente no enviará.
    try {
      await sendPushToUser(appointment.client_id, {
        title: 'StyleX',
        body: `Tu barbero sugiere adelantar la cita a las ${timeLabel}`,
        data: {
          type: 'RESCHEDULE_PROPOSAL',
          notificationId: String(notification.id),
          appointmentId: String(appointment.id),
        },
      });
    } catch (e) {
      console.warn('No se pudo enviar push RESCHEDULE_PROPOSAL:', e?.message || e);
    }
    
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

    try {
      await enforceShopSubscriptionForBooking(client, finalShopId);
    } catch (e) {
      await client.query('ROLLBACK');
      return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
    }
    
    // Normalizar fecha: si viene solo YYYY-MM-DD, agregar T00:00:00
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

    const existing = checkResult.rows[0];
    const shopToCheck = shop_id != null ? shop_id : (existing?.shop_id ?? null);
    if (shopToCheck != null) {
      try {
        await enforceShopSubscriptionForBooking(client, shopToCheck);
      } catch (e) {
        await client.query('ROLLBACK');
        return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
      }
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
      'SELECT id, date, status, shop_id FROM appointments WHERE id = $1',
      [id]
    );

    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Cita no encontrada' });
    }

    const appt = checkResult.rows[0];

    if (appt?.shop_id != null) {
      try {
        await enforceShopSubscriptionForBooking(client, appt.shop_id);
      } catch (e) {
        await client.query('ROLLBACK');
        return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
      }
    }

    const status = String(appt.status || '').toLowerCase();
    const startMs = appt.date ? new Date(appt.date).getTime() : NaN;
    const isPast = Number.isNaN(startMs) ? false : startMs < Date.now();

    const canCancel = status === 'confirmed' || status === 'day_off' || status === 'leave_early';
    if (!canCancel) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'No se puede cancelar esta cita con el estado actual.' });
    }

    if (status === 'confirmed' && isPast) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'No puedes cancelar una cita pasada.' });
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

    const shopToCheck = checkResult.rows[0]?.shop_id ?? null;
    if (shopToCheck != null) {
      try {
        await enforceShopSubscriptionForBooking(client, shopToCheck);
      } catch (e) {
        await client.query('ROLLBACK');
        return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
      }
    }

    const result = await client.query(
      `UPDATE appointments 
       SET status = 'completed',
           actual_end_time = COALESCE(actual_end_time, NOW()),
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, date, actual_end_time, status, notes, client_id, barber_id, shop_id, service_id, payment_method, payment_status, payment_marked_at, payment_marked_by`,
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

export const updateAppointmentPayment = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const {
      paymentMethod,
      payment_method,
      paymentStatus,
      payment_status,
    } = req.body || {};

    const requesterId = req.user?.userId ?? req.body?.requesterId;
    const requesterRole = req.user?.role ?? req.body?.requesterRole;

    const finalPaymentMethod = paymentMethod !== undefined ? paymentMethod : payment_method;
    const finalPaymentStatus = paymentStatus !== undefined ? paymentStatus : payment_status;

    const allowedStatuses = ['paid', 'unpaid', 'pending', null, undefined, ''];
    const allowedMethods = ['cash', 'card', 'transfer', null, undefined, ''];
    const normalizedStatus = String(finalPaymentStatus || '').trim().toLowerCase();
    const normalizedMethod = String(finalPaymentMethod || '').trim().toLowerCase();

    if (!allowedStatuses.includes(finalPaymentStatus) && normalizedStatus) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'paymentStatus inválido. Usa: paid | unpaid | pending' });
    }

    if (!allowedMethods.includes(finalPaymentMethod) && normalizedMethod) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'paymentMethod inválido. Usa: cash | card | transfer' });
    }

    const apptRes = await client.query(
      `SELECT id, barber_id, shop_id
       FROM appointments
       WHERE id = $1`,
      [id]
    );

    if (apptRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Cita no encontrada' });
    }

    const appt = apptRes.rows[0];

    if (appt?.shop_id != null) {
      try {
        await enforceShopSubscriptionForBooking(client, appt.shop_id);
      } catch (e) {
        await client.query('ROLLBACK');
        return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
      }
    }

    const role = String(requesterRole || '').toLowerCase();
    const rid = requesterId != null ? String(requesterId) : null;

    let authorized = false;
    if (role.includes('admin')) authorized = true;
    else if (role.includes('barber')) authorized = rid != null && String(appt.barber_id) === rid;
    else if (role.includes('owner')) {
      if (rid != null) {
        const ownRes = await client.query(
          `SELECT 1
           FROM barber_shops bs
           WHERE bs.id = $1 AND bs.owner_id = $2
           LIMIT 1`,
          [appt.shop_id, rid]
        );
        authorized = ownRes.rows.length > 0;
      }
    }

    if (!authorized) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'No autorizado para actualizar el pago de esta cita' });
    }

    const methodValue = normalizedMethod ? normalizedMethod : null;
    const statusValue = normalizedStatus ? normalizedStatus : null;

    const result = await client.query(
      `UPDATE appointments
       SET payment_method = $1,
           payment_status = $2,
           payment_marked_at = NOW(),
           payment_marked_by = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, date, actual_end_time, status, notes, client_id, barber_id, shop_id, service_id, payment_method, payment_status, payment_marked_at, payment_marked_by`,
      [methodValue, statusValue, requesterId ?? null, id]
    );

    await client.query('COMMIT');
    return res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al actualizar pago de cita:', error);
    return res.status(500).json({ message: 'Error del servidor al actualizar pago de cita' });
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

    const shopToCheck = checkResult.rows[0]?.shop_id ?? null;
    if (shopToCheck != null) {
      try {
        await enforceShopSubscriptionForBooking(client, shopToCheck);
      } catch (e) {
        await client.query('ROLLBACK');
        return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
      }
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
