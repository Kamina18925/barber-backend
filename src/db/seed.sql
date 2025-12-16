-- Script de datos iniciales para Barbería RD
-- Este script inserta datos de ejemplo en las tablas

-- Insertar barberías (primero sin owner_id, lo actualizaremos después)
INSERT INTO barber_shops (id, name, owner_id, address, city, phone) VALUES
('shop1', 'Barbería Moderna RD', 'temp_owner', 'Av. Winston Churchill 1020, Piantini', 'Santo Domingo', '809-555-0101'),
('shop2', 'El Rincón del Barbero Clásico', 'temp_owner', 'Calle El Sol #45, Centro Ciudad', 'Santiago', '829-555-0202');

-- Insertar usuarios
INSERT INTO users (id, name, email, role, phone, password, shop_id) VALUES
-- Clientes
('user1', 'Cliente Ana Pérez', 'ana.perez@example.com', 'client', '809-111-1111', 'password123', NULL),
('user5', 'Carlos Cliente Frecuente', 'carlos.vip@example.com', 'client', '809-555-5555', 'password123', NULL),
-- Propietarios
('user3', 'Laura Dueña (Moderna RD)', 'laura.owner@example.com', 'owner', '809-333-3333', 'password123', NULL),
-- Barberos
('user2', 'Barbero Juan Rodríguez', 'juan.barber@example.com', 'barber', '809-222-2222', 'password123', 'shop1'),
('user4', 'Barbero Pedro Martínez', 'pedro.barber@example.com', 'barber', '809-444-4444', 'password123', 'shop1'),
('user6', 'Sofía (Rincón Clásico)', 'sofia.owner@example.com', 'barber', '809-666-6666', 'password123', 'shop2'),
('user7', 'Barbero Luis Gómez', 'luis.barber@example.com', 'barber', '809-777-7777', 'password123', 'shop2');

-- Actualizar owner_id en barberías
UPDATE barber_shops SET owner_id = 'user3' WHERE id IN ('shop1', 'shop2');

-- Insertar servicios
INSERT INTO services (id, name, price, duration) VALUES
('svc1', 'Corte Clásico', 350, 30),
('svc2', 'Degradado', 400, 40),
('svc3', 'Barba', 250, 20);

-- Asignar servicios a barberos
INSERT INTO barber_services (barber_id, service_id) VALUES
('user2', 'svc1'),
('user2', 'svc2'),
('user4', 'svc2'),
('user7', 'svc1');

-- Insertar disponibilidad de barberos
INSERT INTO barber_availability (barber_id, day, start_time, end_time) VALUES
('user2', 'L', '09:00', '17:00'),
('user2', 'M', '10:00', '18:00'),
('user4', 'L', '08:00', '16:00'),
('user7', 'V', '12:00', '20:00');

-- Insertar citas
INSERT INTO appointments (id, client_id, shop_id, barber_id, service, start_time, status) VALUES
('appt1', 'user1', 'shop1', 'user2', 'Corte Clásico', NOW() + INTERVAL '1 day', 'confirmed'),
('appt2', 'user5', 'shop1', 'user4', 'Degradado', NOW() - INTERVAL '1 day', 'completed'),
('appt3', 'user1', 'shop2', 'user7', 'Barba', NOW() + INTERVAL '2 days', 'confirmed');

-- Insertar productos
INSERT INTO products (id, name, price, stock, category, shop_id, barber_id, photo_url) VALUES
('prod1', 'Pomada Fijadora', 350, 10, 'Cuidado', 'shop1', 'user2', 'https://images.unsplash.com/photo-1519864600265-abb23847ef2c?auto=format&fit=crop&w=200&q=80'),
('prod2', 'Shampoo Anticaspa', 400, 5, 'Cuidado', 'shop1', 'user4', 'https://images.unsplash.com/photo-1515378791036-0648a3ef77b2?auto=format&fit=crop&w=200&q=80'),
('prod3', 'Cera Mate', 250, 7, 'Cuidado', 'shop2', 'user7', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=200&q=80');

-- Insertar fotos de barberías
INSERT INTO barber_shop_photos (shop_id, photo_url) VALUES
('shop1', 'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=400&q=80'),
('shop1', 'https://images.unsplash.com/photo-1519125323398-675f0ddb6308?auto=format&fit=crop&w=400&q=80'),
('shop2', 'https://images.unsplash.com/photo-1464983953574-0892a716854b?auto=format&fit=crop&w=400&q=80');
