import dotenv from 'dotenv';
import app from './app.js';
import pool from './db/connection.js';
import { cleanupDeletedNotifications } from './controllers/notificationController.js';

// Cargar variables de entorno
dotenv.config();

// Puerto (usar 3000 por defecto si no hay variable de entorno PORT)
const PORT = process.env.PORT || 3000;

const ensureNotificationSoftDeleteColumns = async () => {
  try {
    await pool.query(
      `ALTER TABLE notifications
       ADD COLUMN IF NOT EXISTS client_deleted BOOLEAN DEFAULT FALSE`
    );
    await pool.query(
      `ALTER TABLE notifications
       ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`
    );
  } catch (error) {
    console.error('Error asegurando columnas soft-delete en notifications:', error);
  }
};

const ensureAppointmentClientHiddenColumn = async () => {
  try {
    await pool.query(
      `ALTER TABLE appointments
       ADD COLUMN IF NOT EXISTS hidden_for_client BOOLEAN DEFAULT FALSE`
    );
  } catch (error) {
    console.error('Error asegurando columna hidden_for_client en appointments:', error);
  }
};

const ensureConversationArchiveColumns = async () => {
  try {
    await pool.query(
      `ALTER TABLE conversations
       ADD COLUMN IF NOT EXISTS archived_for_client BOOLEAN DEFAULT FALSE`
    );
    await pool.query(
      `ALTER TABLE conversations
       ADD COLUMN IF NOT EXISTS archived_for_barber BOOLEAN DEFAULT FALSE`
    );
  } catch (error) {
    console.error('Error asegurando columnas archived_for_* en conversations:', error);
  }
};

const cleanupChatMessagesByRetention = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Borrar mensajes con más de 31 días
    await client.query(
      `DELETE FROM messages
       WHERE created_at < (NOW() - INTERVAL '31 days')`
    );

    // Borrar conversaciones sin mensajes (por si quedaron vacías tras la limpieza)
    await client.query(
      `DELETE FROM conversations c
       WHERE NOT EXISTS (
         SELECT 1 FROM messages m WHERE m.conversation_id = c.id
       )`
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error ejecutando cleanupChatMessagesByRetention:', error);
  } finally {
    client.release();
  }
};

const startServer = async () => {
  await ensureNotificationSoftDeleteColumns();
  await ensureAppointmentClientHiddenColumn();
  await ensureConversationArchiveColumns();

  // Ejecutar limpieza una vez al iniciar
  try {
    await cleanupDeletedNotifications();
    await cleanupChatMessagesByRetention();
  } catch (error) {
    console.error('Error ejecutando cleanupDeletedNotifications al iniciar:', error);
  }

  // Limpieza periódica (cada 12 horas)
  setInterval(async () => {
    try {
      await cleanupDeletedNotifications();
      await cleanupChatMessagesByRetention();
    } catch (error) {
      console.error('Error ejecutando cleanupDeletedNotifications:', error);
    }
  }, 12 * 60 * 60 * 1000);

  // Iniciar servidor
  app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
    console.log(`API disponible en http://localhost:${PORT}/api`);
  });
};

startServer();
