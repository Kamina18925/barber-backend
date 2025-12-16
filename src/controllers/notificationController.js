import pool from '../db/connection.js';
import { getOrCreateClientBarberConversation } from './chatController.js';

// Obtener notificaciones de un usuario (ordenadas de más recientes a más antiguas)
export const getNotificationsByUser = async (req, res) => {
  const { userId } = req.params;
  const { includeDeleted } = req.query;

  if (!userId) {
    return res.status(400).json({ message: 'userId es requerido' });
  }

  try {
    const shouldIncludeDeleted = String(includeDeleted).toLowerCase() === 'true';
    const result = await pool.query(
      `SELECT *
       FROM notifications
       WHERE user_id = $1
         AND ($2::boolean = true OR COALESCE(client_deleted, false) = false)
       ORDER BY created_at DESC`,
      [userId, shouldIncludeDeleted]
    );

    return res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener notificaciones:', error);
    return res.status(500).json({ message: 'Error del servidor al obtener notificaciones' });
  }
};

// Marcar historial de notificaciones como borrado para el cliente (soft delete)
export const clearNotificationHistoryForUser = async (req, res) => {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ message: 'userId es requerido' });
  }

  try {
    const result = await pool.query(
      `UPDATE notifications
       SET client_deleted = true,
           deleted_at = COALESCE(deleted_at, NOW()),
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING id`,
      [userId]
    );

    return res.json({ success: true, affected: result.rowCount });
  } catch (error) {
    console.error('Error al limpiar historial de notificaciones:', error);
    return res.status(500).json({ message: 'Error del servidor al limpiar historial de notificaciones' });
  }
};

// Limpieza física diferida: elimina notificaciones soft-deleted con más de 31 días
export const cleanupDeletedNotifications = async () => {
  await pool.query(
    `DELETE FROM notifications
     WHERE COALESCE(client_deleted, false) = true
       AND deleted_at IS NOT NULL
       AND deleted_at < NOW() - INTERVAL '31 days'`
  );
};

// Responder a una notificación de propuesta de adelanto (aceptar / rechazar)
export const respondToNotification = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { accepted } = req.body || {};

    const notifRes = await client.query(
      `SELECT * FROM notifications WHERE id = $1`,
      [id]
    );

    if (notifRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Notificación no encontrada' });
    }

    const notification = notifRes.rows[0];

    // Solo manejamos aquí las propuestas de adelanto
    if (notification.type !== 'RESCHEDULE_PROPOSAL') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Esta notificación no admite respuesta de adelanto' });
    }

    const payload = notification.payload || {};
    const appointmentId = payload.appointmentId;
    const newTime = payload.newTime;

    if (!appointmentId || !newTime) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'La notificación no tiene datos suficientes para procesar la propuesta' });
    }

    let updatedAppointment = null;

    if (accepted) {
      // Actualizar la cita con la nueva fecha/hora
      const updateRes = await client.query(
        `UPDATE appointments
         SET date = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [newTime, appointmentId]
      );

      if (updateRes.rows.length > 0) {
        updatedAppointment = updateRes.rows[0];
      }
    }

    // Actualizar estado de la notificación
    const newStatus = accepted ? 'ACCEPTED' : 'REJECTED';
    const updatedNotifRes = await client.query(
      `UPDATE notifications
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [newStatus, id]
    );

    await client.query('COMMIT');

    const updatedNotification = updatedNotifRes.rows[0];

    // Crear mensaje de sistema en el chat cliente-barbero indicando la respuesta
    try {
      // Obtener datos básicos de la cita para saber client_id y barber_id
      const apptRes = await pool.query(
        `SELECT id, client_id, barber_id
         FROM appointments
         WHERE id = $1`,
        [appointmentId]
      );

      if (apptRes.rows.length > 0) {
        const appt = apptRes.rows[0];
        const conversationId = await getOrCreateClientBarberConversation(appt.id);
        if (conversationId) {
          const text = accepted
            ? 'He aceptado el adelanto de la cita.'
            : 'He rechazado la propuesta de adelanto.';

          // Suponemos que quien responde es el cliente, dirigido al barbero
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
              appt.client_id,
              appt.barber_id,
              text,
              true,
              'RESCHEDULE_RESPONSE',
              String(updatedNotification.id),
            ]
          );
        }
      }
    } catch (msgError) {
      console.error('Error al crear mensaje automático de respuesta de adelanto:', msgError);
    }

    return res.json({
      notification: updatedNotification,
      appointment: updatedAppointment,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al responder notificación:', error);
    return res.status(500).json({ message: 'Error del servidor al responder notificación' });
  } finally {
    client.release();
  }
};
