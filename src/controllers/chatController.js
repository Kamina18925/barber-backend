import pool from '../db/connection.js';

// Helper: obtener o crear conversación cliente-barbero ligada a una cita
export const getOrCreateClientBarberConversation = async (appointmentId) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const apptRes = await client.query(
      'SELECT id, client_id, barber_id FROM appointments WHERE id = $1',
      [appointmentId]
    );

    if (apptRes.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('Cita no encontrada para crear conversación');
    }

    const appt = apptRes.rows[0];

    // Buscar conversación existente cliente-barbero para esta cita
    const convRes = await client.query(
      `SELECT id FROM conversations
       WHERE type = 'client_barber'
         AND appointment_id = $1
         AND client_id = $2
         AND barber_id = $3
       LIMIT 1`,
      [appt.id, appt.client_id, appt.barber_id]
    );

    if (convRes.rows.length > 0) {
      const convId = convRes.rows[0].id;
      const noticeRes = await client.query(
        `SELECT 1
         FROM messages
         WHERE conversation_id = $1
           AND is_system = TRUE
           AND related_action = 'RETENTION_POLICY'
         LIMIT 1`,
        [convId]
      );
      if (noticeRes.rows.length === 0) {
        await client.query(
          `INSERT INTO messages (conversation_id, sender_id, receiver_id, text, is_system, related_action, related_id)
           VALUES ($1, $2, $3, $4, TRUE, 'RETENTION_POLICY', NULL)`,
          [
            convId,
            appt.client_id,
            appt.barber_id,
            'Aviso: Los mensajes se eliminan automáticamente 31 días después de ser enviados. Si deseas borrar una conversación, puedes eliminarla individualmente; se borrará permanentemente cuando ambas partes la eliminen.'
          ]
        );
      }
      await client.query('COMMIT');
      return convId;
    }

    const insertRes = await client.query(
      `INSERT INTO conversations (
         type, client_id, barber_id, appointment_id
       ) VALUES ('client_barber', $1, $2, $3)
       RETURNING id`,
      [appt.client_id, appt.barber_id, appt.id]
    );

    await client.query(
      `INSERT INTO messages (conversation_id, sender_id, receiver_id, text, is_system, related_action, related_id)
       VALUES ($1, $2, $3, $4, TRUE, 'RETENTION_POLICY', NULL)`,
      [
        insertRes.rows[0].id,
        appt.client_id,
        appt.barber_id,
        'Aviso: Los mensajes se eliminan automáticamente 31 días después de ser enviados. Si deseas borrar una conversación, puedes eliminarla individualmente; se borrará permanentemente cuando ambas partes la eliminen.'
      ]
    );

    await client.query('COMMIT');
    return insertRes.rows[0].id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const getOrCreateDirectConversation = async (req, res) => {
  const { clientId, barberId } = req.body || {};
  if (!clientId || !barberId) {
    return res.status(400).json({ message: 'clientId y barberId son requeridos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id
       FROM conversations
       WHERE type = 'client_barber_direct'
         AND client_id = $1
         AND barber_id = $2
       LIMIT 1`,
      [clientId, barberId]
    );

    let conversationId;
    if (existing.rows.length > 0) {
      conversationId = existing.rows[0].id;
      await client.query(
        `UPDATE conversations
         SET archived_for_client = FALSE,
             archived_for_barber = FALSE,
             updated_at = NOW()
         WHERE id = $1`,
        [conversationId]
      );
    } else {
      const inserted = await client.query(
        `INSERT INTO conversations (type, client_id, barber_id, appointment_id)
         VALUES ('client_barber_direct', $1, $2, NULL)
         RETURNING id`,
        [clientId, barberId]
      );
      conversationId = inserted.rows[0].id;
    }

    const noticeRes = await client.query(
      `SELECT 1
       FROM messages
       WHERE conversation_id = $1
         AND is_system = TRUE
         AND related_action = 'RETENTION_POLICY'
       LIMIT 1`,
      [conversationId]
    );

    if (noticeRes.rows.length === 0) {
      await client.query(
        `INSERT INTO messages (conversation_id, sender_id, receiver_id, text, is_system, related_action, related_id)
         VALUES ($1, $2, $3, $4, TRUE, 'RETENTION_POLICY', NULL)`,
        [
          conversationId,
          clientId,
          barberId,
          'Aviso: Los mensajes se eliminan automáticamente 31 días después de ser enviados. Si deseas borrar una conversación, puedes eliminarla individualmente; se borrará permanentemente cuando ambas partes la eliminen.'
        ]
      );
    }

    await client.query('COMMIT');
    return res.json({ conversationId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al obtener/crear conversación directa:', error);
    return res.status(500).json({ message: 'Error del servidor al obtener/crear conversación directa' });
  } finally {
    client.release();
  }
};

export const getUserConversations = async (req, res) => {
  const { userId } = req.params;
  if (!userId) {
    return res.status(400).json({ message: 'userId es requerido' });
  }

  try {
    const result = await pool.query(
      `SELECT
         conv.id,
         conv.type,
         conv.client_id,
         conv.barber_id,
         conv.owner_id,
         conv.appointment_id,
         conv.created_at,
         conv.updated_at,
         CASE WHEN conv.client_id = $1 THEN conv.barber_id ELSE conv.client_id END AS partner_id,
         u.name AS partner_name,
         (
           SELECT MAX(m.created_at)
           FROM messages m
           WHERE m.conversation_id = conv.id
             AND NOT (m.is_system = TRUE AND m.related_action = 'RETENTION_POLICY')
         ) AS last_message_at,
         (
           SELECT m2.text
           FROM messages m2
           WHERE m2.conversation_id = conv.id
             AND NOT (m2.is_system = TRUE AND m2.related_action = 'RETENTION_POLICY')
           ORDER BY m2.created_at DESC
           LIMIT 1
         ) AS last_message_text,
         (
           SELECT COUNT(*)
           FROM messages m3
           WHERE m3.conversation_id = conv.id
             AND m3.receiver_id = $1
             AND m3.read_at IS NULL
             AND NOT (m3.is_system = TRUE AND m3.related_action = 'RETENTION_POLICY')
         ) AS unread_count
       FROM conversations conv
       LEFT JOIN users u
         ON u.id = (CASE WHEN conv.client_id = $1 THEN conv.barber_id ELSE conv.client_id END)
       WHERE (
         (conv.client_id = $1 AND COALESCE(conv.archived_for_client, FALSE) = FALSE)
         OR
         (conv.barber_id = $1 AND COALESCE(conv.archived_for_barber, FALSE) = FALSE)
       )
       ORDER BY last_message_at DESC NULLS LAST, conv.updated_at DESC, conv.created_at DESC`,
      [userId]
    );

    return res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener conversaciones del usuario:', error);
    return res.status(500).json({ message: 'Error del servidor al obtener conversaciones' });
  }
};

export const archiveConversationForUser = async (req, res) => {
  const { conversationId } = req.params;
  const { userId } = req.body || {};

  if (!conversationId || !userId) {
    return res.status(400).json({ message: 'conversationId y userId son requeridos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const convRes = await client.query(
      `SELECT id, client_id, barber_id,
              COALESCE(archived_for_client, FALSE) AS archived_for_client,
              COALESCE(archived_for_barber, FALSE) AS archived_for_barber
       FROM conversations
       WHERE id = $1
       LIMIT 1`,
      [conversationId]
    );

    if (convRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Conversación no encontrada' });
    }

    const conv = convRes.rows[0];
    const isClient = String(conv.client_id) === String(userId);
    const isBarber = String(conv.barber_id) === String(userId);
    if (!isClient && !isBarber) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'No tienes acceso a esta conversación' });
    }

    const updated = await client.query(
      `UPDATE conversations
       SET archived_for_client = CASE WHEN client_id = $2 THEN TRUE ELSE COALESCE(archived_for_client, FALSE) END,
           archived_for_barber = CASE WHEN barber_id = $2 THEN TRUE ELSE COALESCE(archived_for_barber, FALSE) END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, client_id, barber_id,
                 COALESCE(archived_for_client, FALSE) AS archived_for_client,
                 COALESCE(archived_for_barber, FALSE) AS archived_for_barber`,
      [conversationId, userId]
    );

    const u = updated.rows[0];
    if (u.archived_for_client && u.archived_for_barber) {
      await client.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
      await client.query('COMMIT');
      return res.json({ deleted: true });
    }

    await client.query('COMMIT');
    return res.json({ archived: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al archivar conversación:', error);
    return res.status(500).json({ message: 'Error del servidor al archivar conversación' });
  } finally {
    client.release();
  }
};

// Listar conversaciones visibles para un dueño (owner) según sus barberías
export const getOwnerConversations = async (req, res) => {
  const { ownerId } = req.params;

  if (!ownerId) {
    return res.status(400).json({ message: 'ownerId es requerido' });
  }

  try {
    const result = await pool.query(
      `SELECT
         conv.id,
         conv.type,
         conv.appointment_id,
         conv.created_at,
         conv.updated_at,
         c.name  AS client_name,
         b.name  AS barber_name,
         bs.name AS shop_name,
         (
           SELECT MAX(m.created_at)
           FROM messages m
           WHERE m.conversation_id = conv.id
             AND NOT (m.is_system = TRUE AND m.related_action = 'RETENTION_POLICY')
         ) AS last_message_at,
         (
           SELECT m2.text
           FROM messages m2
           WHERE m2.conversation_id = conv.id
             AND NOT (m2.is_system = TRUE AND m2.related_action = 'RETENTION_POLICY')
           ORDER BY m2.created_at DESC
           LIMIT 1
         ) AS last_message_text,
         (
           SELECT COUNT(*)
           FROM messages m3
           WHERE m3.conversation_id = conv.id
             AND m3.receiver_id = conv.client_id
             AND m3.read_at IS NULL
             AND NOT (m3.is_system = TRUE AND m3.related_action = 'RETENTION_POLICY')
         ) AS unread_for_client,
         (
           SELECT COUNT(*)
           FROM messages m4
           WHERE m4.conversation_id = conv.id
             AND m4.receiver_id = conv.barber_id
             AND m4.read_at IS NULL
             AND NOT (m4.is_system = TRUE AND m4.related_action = 'RETENTION_POLICY')
         ) AS unread_for_barber
       FROM conversations conv
       LEFT JOIN appointments a ON conv.appointment_id = a.id
       LEFT JOIN users c ON conv.client_id = c.id
       LEFT JOIN users b ON conv.barber_id = b.id
       LEFT JOIN barber_shops bs ON a.shop_id = bs.id
       WHERE bs.owner_id = $1
       ORDER BY last_message_at DESC NULLS LAST, conv.created_at DESC`,
      [ownerId]
    );

    return res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener conversaciones para dueño:', error);
    return res.status(500).json({ message: 'Error del servidor al obtener conversaciones para dueño' });
  }
};

// Marcar como leídos los mensajes donde el usuario es el receptor en una conversación
export const markMessagesAsReadForConversation = async (req, res) => {
  const { conversationId } = req.params;
  const { userId } = req.body || {};

  if (!conversationId || !userId) {
    return res.status(400).json({ message: 'conversationId y userId son requeridos' });
  }

  try {
    const result = await pool.query(
      `UPDATE messages
       SET read_at = NOW()
       WHERE conversation_id = $1
         AND receiver_id = $2
         AND read_at IS NULL`,
      [conversationId, userId]
    );

    return res.json({ updatedCount: result.rowCount || 0 });
  } catch (error) {
    console.error('Error al marcar mensajes como leídos:', error);
    return res.status(500).json({ message: 'Error del servidor al marcar mensajes como leídos' });
  }
};

// Endpoint: obtener o crear conversación cliente-barbero por appointmentId
export const getOrCreateConversationForAppointment = async (req, res) => {
  const { appointmentId } = req.params;

  if (!appointmentId) {
    return res.status(400).json({ message: 'appointmentId es requerido' });
  }

  try {
    const conversationId = await getOrCreateClientBarberConversation(appointmentId);
    return res.json({ conversationId });
  } catch (error) {
    console.error('Error al obtener/crear conversación para cita:', error);
    return res.status(500).json({ message: 'Error del servidor al obtener/crear conversación' });
  }
};

// Crear un mensaje en una conversación existente
export const createMessage = async (req, res) => {
  const { conversationId, senderId, receiverId, text, isSystem, relatedAction, relatedId } =
    req.body || {};

  if (!conversationId || !senderId || !receiverId || !text) {
    return res.status(400).json({ message: 'Faltan datos para crear el mensaje' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO messages (
         conversation_id,
         sender_id,
         receiver_id,
         text,
         is_system,
         related_action,
         related_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [conversationId, senderId, receiverId, text, !!isSystem, relatedAction ?? null, relatedId ?? null]
    );

    await pool.query(
      `UPDATE conversations
       SET archived_for_client = CASE WHEN client_id = $2 OR client_id = $3 THEN FALSE ELSE COALESCE(archived_for_client, FALSE) END,
           archived_for_barber = CASE WHEN barber_id = $2 OR barber_id = $3 THEN FALSE ELSE COALESCE(archived_for_barber, FALSE) END,
           updated_at = NOW()
       WHERE id = $1`,
      [conversationId, senderId, receiverId]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al crear mensaje de chat:', error);
    return res.status(500).json({ message: 'Error del servidor al crear mensaje' });
  }
};

// Obtener mensajes de una conversación
export const getMessagesByConversation = async (req, res) => {
  const { conversationId } = req.params;

  if (!conversationId) {
    return res.status(400).json({ message: 'conversationId es requerido' });
  }

  try {
    const result = await pool.query(
      `SELECT m.*,
              us.name AS sender_name,
              ur.name AS receiver_name
       FROM messages m
       LEFT JOIN users us ON m.sender_id = us.id
       LEFT JOIN users ur ON m.receiver_id = ur.id
       WHERE m.conversation_id = $1
       ORDER BY m.created_at ASC`,
      [conversationId]
    );

    return res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener mensajes de conversación:', error);
    return res.status(500).json({ message: 'Error del servidor al obtener mensajes' });
  }
};
