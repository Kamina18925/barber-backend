-- Esquema de base de datos para Barbería RD
-- Este script crea todas las tablas necesarias para la aplicación

-- Eliminar tablas existentes si es necesario (en orden inverso a las dependencias)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    uuid VARCHAR(50) UNIQUE,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    phone VARCHAR(20),
    gender VARCHAR(10),
    password VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL, -- 'barber', 'client', 'owner'
    specialties TEXT[],
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Barbershops table (without initial references)
CREATE TABLE barber_shops (
    id SERIAL PRIMARY KEY,
    uuid VARCHAR(50) UNIQUE,
    name VARCHAR(100) NOT NULL,
    address VARCHAR(200),
    schedule JSONB,
    categories TEXT[] DEFAULT ARRAY['barberia'],
    rating NUMERIC(2,1),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Services table (without initial references)
CREATE TABLE services (
    id SERIAL PRIMARY KEY,
    uuid VARCHAR(50) UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    price NUMERIC(10,2) NOT NULL,
    duration INT NOT NULL, -- minutes
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Appointments table (without initial references)
CREATE TABLE appointments (
    id SERIAL PRIMARY KEY,
    uuid VARCHAR(50) UNIQUE,
    date TIMESTAMP NOT NULL,
    status VARCHAR(20) NOT NULL, -- confirmed, completed, cancelled, no-show
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Products table (without initial references)
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    uuid VARCHAR(50) UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    price NUMERIC(10,2) NOT NULL,
    discount_price NUMERIC(10,2),
    stock INT DEFAULT 0,
    image_url TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Reviews table (without initial references)
CREATE TABLE reviews (
    id SERIAL PRIMARY KEY,
    uuid VARCHAR(50) UNIQUE,
    rating INT CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Appointment notes table (without initial references)
CREATE TABLE appointment_notes (
    id SERIAL PRIMARY KEY,
    note TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Extra services added to an appointment (without initial references)
CREATE TABLE appointment_extras (
    id SERIAL PRIMARY KEY,
    price NUMERIC(10,2),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Appointment status history table (without initial references)
CREATE TABLE appointment_status_history (
    id SERIAL PRIMARY KEY,
    status VARCHAR(20),
    changed_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Now we add all references using ALTER TABLE

-- References for users
ALTER TABLE users ADD COLUMN shop_id INTEGER;
ALTER TABLE users ADD CONSTRAINT fk_users_shop FOREIGN KEY (shop_id) REFERENCES barber_shops(id);

-- References for barber_shops
ALTER TABLE barber_shops ADD COLUMN owner_id INTEGER;
ALTER TABLE barber_shops ADD CONSTRAINT fk_barber_shops_owner FOREIGN KEY (owner_id) REFERENCES users(id);

-- References for services
ALTER TABLE services ADD COLUMN shop_id INTEGER;
ALTER TABLE services ADD CONSTRAINT fk_services_shop FOREIGN KEY (shop_id) REFERENCES barber_shops(id);

-- References for appointments
ALTER TABLE appointments ADD COLUMN client_id INTEGER;
ALTER TABLE appointments ADD COLUMN barber_id INTEGER;
ALTER TABLE appointments ADD COLUMN shop_id INTEGER;
ALTER TABLE appointments ADD COLUMN service_id INTEGER;
ALTER TABLE appointments ADD CONSTRAINT fk_appointments_client FOREIGN KEY (client_id) REFERENCES users(id);
ALTER TABLE appointments ADD CONSTRAINT fk_appointments_barber FOREIGN KEY (barber_id) REFERENCES users(id);
ALTER TABLE appointments ADD CONSTRAINT fk_appointments_shop FOREIGN KEY (shop_id) REFERENCES barber_shops(id);
ALTER TABLE appointments ADD CONSTRAINT fk_appointments_service FOREIGN KEY (service_id) REFERENCES services(id);

-- Evitar dos citas reales en el mismo horario para el mismo barbero
ALTER TABLE appointments
  ADD CONSTRAINT uq_appointments_barber_date UNIQUE (barber_id, date);

-- References for products
ALTER TABLE products ADD COLUMN shop_id INTEGER;
ALTER TABLE products ADD CONSTRAINT fk_products_shop FOREIGN KEY (shop_id) REFERENCES barber_shops(id);

-- References for reviews
ALTER TABLE reviews ADD COLUMN user_id INTEGER;
ALTER TABLE reviews ADD COLUMN shop_id INTEGER;
ALTER TABLE reviews ADD CONSTRAINT fk_reviews_user FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE reviews ADD CONSTRAINT fk_reviews_shop FOREIGN KEY (shop_id) REFERENCES barber_shops(id);

-- References for appointment_notes
ALTER TABLE appointment_notes ADD COLUMN appointment_id INTEGER;
ALTER TABLE appointment_notes ADD CONSTRAINT fk_appointment_notes_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id);

-- References for appointment_extras
ALTER TABLE appointment_extras ADD COLUMN appointment_id INTEGER;
ALTER TABLE appointment_extras ADD COLUMN service_id INTEGER;
ALTER TABLE appointment_extras ADD CONSTRAINT fk_appointment_extras_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id);
ALTER TABLE appointment_extras ADD CONSTRAINT fk_appointment_extras_service FOREIGN KEY (service_id) REFERENCES services(id);

-- References for appointment_status_history
ALTER TABLE appointment_status_history ADD COLUMN appointment_id INTEGER;
ALTER TABLE appointment_status_history ADD CONSTRAINT fk_appointment_status_history_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id);

-- Sessions table (for authentication)
CREATE TABLE sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    token VARCHAR(255) UNIQUE,
    expires_at TIMESTAMP
);

-- Función para actualizar el timestamp de updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = CURRENT_TIMESTAMP;
   RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers para actualizar automáticamente updated_at
CREATE TRIGGER update_barber_shops_updated_at BEFORE UPDATE
ON barber_shops FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

CREATE TRIGGER update_users_updated_at BEFORE UPDATE
ON users FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

CREATE TRIGGER update_services_updated_at BEFORE UPDATE
ON services FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

CREATE TRIGGER update_appointments_updated_at BEFORE UPDATE
ON appointments FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

CREATE TRIGGER update_products_updated_at BEFORE UPDATE
ON products FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

-- ==========================================
-- Tablas para sistema de mensajería interna
-- ==========================================

-- Conversaciones entre usuarios (cliente-barbero, barbero-owner, etc.)
CREATE TABLE conversations (
    id SERIAL PRIMARY KEY,
    type VARCHAR(30) NOT NULL, -- 'client_barber', 'barber_owner', etc.
    client_id INTEGER,
    barber_id INTEGER,
    owner_id INTEGER,
    appointment_id INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT fk_conversations_client FOREIGN KEY (client_id) REFERENCES users(id),
    CONSTRAINT fk_conversations_barber FOREIGN KEY (barber_id) REFERENCES users(id),
    CONSTRAINT fk_conversations_owner FOREIGN KEY (owner_id) REFERENCES users(id),
    CONSTRAINT fk_conversations_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id)
);

-- Mensajes individuales dentro de una conversación
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    is_system BOOLEAN DEFAULT FALSE,
    related_action VARCHAR(50), -- ej: 'RESCHEDULE_PROPOSAL'
    related_id VARCHAR(50),     -- id de notificación u otra entidad relacionada
    created_at TIMESTAMP DEFAULT NOW(),
    read_at TIMESTAMP,
    CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES users(id),
    CONSTRAINT fk_messages_receiver FOREIGN KEY (receiver_id) REFERENCES users(id)
);

-- Notificaciones internas asociadas al usuario (campana de alertas)
CREATE TABLE notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    type VARCHAR(50) NOT NULL, -- 'RESCHEDULE_PROPOSAL', 'GENERAL', etc.
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING', -- 'PENDING', 'ACCEPTED', 'REJECTED', 'READ'
    payload JSONB, -- datos adicionales (p.ej., nueva hora propuesta)
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Triggers para actualizar automáticamente updated_at de las nuevas tablas
CREATE TRIGGER update_conversations_updated_at BEFORE UPDATE
ON conversations FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

CREATE TRIGGER update_notifications_updated_at BEFORE UPDATE
ON notifications FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
