import dotenv from 'dotenv';
import app from './app.js';
import pool from './db/connection.js';
import { cleanupDeletedNotifications } from './controllers/notificationController.js';

// Cargar variables de entorno
dotenv.config();

// Puerto (usar 3000 por defecto si no hay variable de entorno PORT)
const PORT = process.env.PORT || 3000;

const ensureCoreTablesExist = async () => {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS barber_shops (
        id SERIAL PRIMARY KEY,
        uuid VARCHAR(50) UNIQUE,
        name VARCHAR(100) NOT NULL,
        address VARCHAR(200),
        schedule JSONB,
        categories TEXT[] DEFAULT ARRAY['barberia']::text[],
        rating NUMERIC(3,1),
        owner_id INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS services (
        id SERIAL PRIMARY KEY,
        uuid VARCHAR(50) UNIQUE,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        price NUMERIC(10,2) NOT NULL,
        duration INT NOT NULL,
        shop_id INTEGER REFERENCES barber_shops(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        uuid VARCHAR(50) UNIQUE,
        date TIMESTAMP NOT NULL,
        status VARCHAR(40) NOT NULL,
        notes TEXT,
        notes_barber TEXT,
        client_reviewed BOOLEAN DEFAULT FALSE,
        actual_end_time TIMESTAMP,
        hidden_for_client BOOLEAN DEFAULT FALSE,
        payment_method TEXT,
        payment_status TEXT,
        payment_marked_at TIMESTAMP,
        payment_marked_by INTEGER,
        client_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        barber_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        shop_id INTEGER REFERENCES barber_shops(id) ON DELETE SET NULL,
        service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        uuid VARCHAR(50) UNIQUE,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        price NUMERIC(10,2) NOT NULL,
        discount_price NUMERIC(10,2),
        stock INT DEFAULT 0,
        image_url TEXT,
        shop_id INTEGER REFERENCES barber_shops(id) ON DELETE SET NULL,
        barber_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        uuid VARCHAR(50) UNIQUE,
        rating INT CHECK (rating >= 1 AND rating <= 5),
        comment TEXT,
        photo_url TEXT,
        appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        shop_id INTEGER REFERENCES barber_shops(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        type VARCHAR(30) NOT NULL,
        client_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        barber_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
        archived_for_client BOOLEAN DEFAULT FALSE,
        archived_for_barber BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        receiver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        text TEXT NOT NULL,
        is_system BOOLEAN DEFAULT FALSE,
        related_action VARCHAR(50),
        related_id VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW(),
        read_at TIMESTAMP
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'PENDING',
        payload JSONB,
        client_deleted BOOLEAN DEFAULT FALSE,
        deleted_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS barber_services (
        id SERIAL PRIMARY KEY,
        barber_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (barber_id, service_id)
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS barber_availability (
        id SERIAL PRIMARY KEY,
        barber_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day CHAR(1) NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS barber_breaks (
        id SERIAL PRIMARY KEY,
        barber_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day CHAR(1) NOT NULL CHECK (day IN ('L','M','X','J','V','S','D')),
        break_type VARCHAR(20) NOT NULL CHECK (break_type IN ('breakfast','lunch','dinner')),
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (barber_id, day, break_type)
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        token VARCHAR(255) UNIQUE,
        expires_at TIMESTAMP
      )`
    );
  } catch (error) {
    console.error('Error asegurando tablas core:', error);
  }
};

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

const ensureAppointmentsBarberNotesColumn = async () => {
  try {
    await pool.query(
      `ALTER TABLE appointments
       ADD COLUMN IF NOT EXISTS notes_barber TEXT`
    );
  } catch (error) {
    console.error('Error asegurando columna notes_barber en appointments:', error);
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

const ensureUsersWhatsappLinkColumn = async () => {
  try {
    await pool.query(
      `ALTER TABLE users
       ADD COLUMN IF NOT EXISTS whatsapp_link TEXT`
    );
  } catch (error) {
    console.error('Error asegurando columna whatsapp_link en users:', error);
  }
};

const ensureUsersPhotoUrlColumn = async () => {
  try {
    await pool.query(
      `ALTER TABLE users
       ADD COLUMN IF NOT EXISTS photo_url TEXT`
    );
  } catch (error) {
    console.error('Error asegurando columna photo_url en users:', error);
  }
};

const ensureUsersGenderColumn = async () => {
  try {
    await pool.query(
      `ALTER TABLE users
       ADD COLUMN IF NOT EXISTS gender TEXT`
    );
  } catch (error) {
    console.error('Error asegurando columna gender en users:', error);
  }
};

const ensureBarberShopsCategoriesColumn = async () => {
  try {
    await pool.query(
      `ALTER TABLE barber_shops
       ADD COLUMN IF NOT EXISTS categories TEXT[]`
    );
    await pool.query(
      `ALTER TABLE barber_shops
       ALTER COLUMN categories SET DEFAULT ARRAY['barberia']::text[]`
    );
  } catch (error) {
    console.error('Error asegurando columna categories en barber_shops:', error);
  }
};

const ensureAppointmentsClientReviewedColumn = async () => {
  try {
    await pool.query(
      `ALTER TABLE appointments
       ADD COLUMN IF NOT EXISTS client_reviewed BOOLEAN DEFAULT FALSE`
    );
  } catch (error) {
    console.error('Error asegurando columna client_reviewed en appointments:', error);
  }
};

const ensureAppointmentsActualEndTimeColumn = async () => {
  try {
    await pool.query(
      `ALTER TABLE appointments
       ADD COLUMN IF NOT EXISTS actual_end_time TIMESTAMP`
    );
  } catch (error) {
    console.error('Error asegurando columna actual_end_time en appointments:', error);
  }
};

const ensureAppointmentsPaymentColumns = async () => {
  try {
    await pool.query(
      `ALTER TABLE appointments
       ADD COLUMN IF NOT EXISTS payment_method TEXT`
    );
    await pool.query(
      `ALTER TABLE appointments
       ADD COLUMN IF NOT EXISTS payment_status TEXT`
    );
    await pool.query(
      `ALTER TABLE appointments
       ADD COLUMN IF NOT EXISTS payment_marked_at TIMESTAMP`
    );
    await pool.query(
      `ALTER TABLE appointments
       ADD COLUMN IF NOT EXISTS payment_marked_by INTEGER`
    );
  } catch (error) {
    console.error('Error asegurando columnas de pago en appointments:', error);
  }
};

const ensureReviewsColumns = async () => {
  try {
    await pool.query(
      `ALTER TABLE reviews
       ADD COLUMN IF NOT EXISTS appointment_id INTEGER`
    );
    await pool.query(
      `ALTER TABLE reviews
       ADD COLUMN IF NOT EXISTS photo_url TEXT`
    );
  } catch (error) {
    console.error('Error asegurando columnas adicionales en reviews:', error);
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
  await ensureCoreTablesExist();
  await ensureNotificationSoftDeleteColumns();
  await ensureAppointmentClientHiddenColumn();
  await ensureConversationArchiveColumns();
  await ensureUsersWhatsappLinkColumn();
  await ensureUsersPhotoUrlColumn();
  await ensureUsersGenderColumn();
  await ensureBarberShopsCategoriesColumn();
  await ensureAppointmentsClientReviewedColumn();
  await ensureAppointmentsActualEndTimeColumn();
  await ensureAppointmentsBarberNotesColumn();
  await ensureAppointmentsPaymentColumns();
  await ensureReviewsColumns();

  // Ejecutar limpieza una vez al iniciar
  try {
    await cleanupDeletedNotifications();
    await cleanupChatMessagesByRetention();
  } catch (error) {
    console.error('Error ejecutando cleanupDeletedNotifications al iniciar:', error);
  }

  // Limpieza periódica (cada 12 horas)
  const cleanupIntervalId = setInterval(async () => {
    try {
      await cleanupDeletedNotifications();
      await cleanupChatMessagesByRetention();
    } catch (error) {
      console.error('Error ejecutando cleanupDeletedNotifications:', error);
    }
  }, 12 * 60 * 60 * 1000);

  // Iniciar servidor
  const server = app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
    console.log(`API disponible en http://localhost:${PORT}/api`);
  });

  const shutdown = async (exitCode = 0) => {
    try {
      clearInterval(cleanupIntervalId);
    } catch (e) {
    }

    try {
      await new Promise((resolve) => server.close(() => resolve()));
    } catch (e) {
    }

    try {
      await pool.end();
    } catch (e) {
    }

    process.exit(exitCode);
  };

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Error: el puerto ${PORT} ya está en uso. Cierra el proceso que lo esté usando y vuelve a intentar.`);
      return shutdown(1);
    }
    console.error('Error del servidor HTTP:', err);
    return shutdown(1);
  });

  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));
  process.once('uncaughtException', (err) => {
    console.error('uncaughtException:', err);
    void shutdown(1);
  });
  process.once('unhandledRejection', (reason) => {
    console.error('unhandledRejection:', reason);
    void shutdown(1);
  });
};

startServer();
