-- Script para resetear credenciales en la base de datos Barbería RD
-- Ejecutar como usuario con privilegios administrativos en PostgreSQL

-- 1. Resetear contraseñas de usuarios existentes a valores seguros
-- La contraseña se establece a 'Admin123!' (hash bcrypt)
UPDATE users 
SET password = '$2b$10$XtZZYFzLBSqzWh8HKUd4ZOVToaqYDvN8XjIK9BUZjmI.GQn7HFV3S',
    updated_at = CURRENT_TIMESTAMP
WHERE role IN ('owner', 'admin');

-- Resetear contraseñas de barberos a 'Barber123!'
UPDATE users 
SET password = '$2b$10$GqJTWG7tLGhSIVNnPLfBP.wvRgVQITZ1TfmXxJgUMFQ6AoNHwMyV2',
    updated_at = CURRENT_TIMESTAMP
WHERE role = 'barber';

-- Resetear contraseñas de clientes a 'Cliente123!'
UPDATE users 
SET password = '$2b$10$KJ.VhG3PJ.P5TF15SQjDtu1RAWgtBK0h5J9QRUZ9o9kLx3NjkMKfu',
    updated_at = CURRENT_TIMESTAMP
WHERE role = 'client';

-- 2. Crear usuario administrador si no existe
INSERT INTO users (
    uuid,
    name, 
    email, 
    phone, 
    password, 
    role, 
    created_at,
    updated_at
) 
SELECT 
    md5(random()::text || clock_timestamp()::text)::uuid, 
    'Administrador', 
    'admin@barberiaRD.com', 
    '809-123-4567', 
    '$2b$10$XtZZYFzLBSqzWh8HKUd4ZOVToaqYDvN8XjIK9BUZjmI.GQn7HFV3S', -- 'Admin123!'
    'admin',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
WHERE NOT EXISTS (
    SELECT 1 FROM users WHERE email = 'admin@barberiaRD.com'
);

-- 3. Crear propietario de demostración si no existe
INSERT INTO users (
    uuid,
    name, 
    email, 
    phone, 
    password, 
    role, 
    created_at,
    updated_at
) 
SELECT 
    md5(random()::text || clock_timestamp()::text)::uuid,
    'Propietario Demo', 
    'owner@barberiaRD.com', 
    '809-456-7890', 
    '$2b$10$XtZZYFzLBSqzWh8HKUd4ZOVToaqYDvN8XjIK9BUZjmI.GQn7HFV3S', -- 'Admin123!'
    'owner',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
WHERE NOT EXISTS (
    SELECT 1 FROM users WHERE email = 'owner@barberiaRD.com'
);

-- 4. Crear barbero de demostración si no existe
INSERT INTO users (
    uuid,
    name, 
    email, 
    phone, 
    password, 
    role, 
    created_at,
    updated_at
) 
SELECT 
    md5(random()::text || clock_timestamp()::text)::uuid,
    'Barbero Demo', 
    'barber@barberiaRD.com', 
    '809-234-5678', 
    '$2b$10$GqJTWG7tLGhSIVNnPLfBP.wvRgVQITZ1TfmXxJgUMFQ6AoNHwMyV2', -- 'Barber123!'
    'barber',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
WHERE NOT EXISTS (
    SELECT 1 FROM users WHERE email = 'barber@barberiaRD.com'
);

-- 5. Crear cliente de demostración si no existe
INSERT INTO users (
    uuid,
    name, 
    email, 
    phone, 
    password, 
    role, 
    created_at,
    updated_at
) 
SELECT 
    md5(random()::text || clock_timestamp()::text)::uuid,
    'Cliente Demo', 
    'cliente@barberiaRD.com', 
    '809-876-5432', 
    '$2b$10$KJ.VhG3PJ.P5TF15SQjDtu1RAWgtBK0h5J9QRUZ9o9kLx3NjkMKfu', -- 'Cliente123!'
    'client',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
WHERE NOT EXISTS (
    SELECT 1 FROM users WHERE email = 'cliente@barberiaRD.com'
);

-- 6. Asignar una barbería al barbero de demostración si es necesario
-- Primero, verificamos si existe alguna barbería
DO $$
DECLARE 
    barber_user_id INTEGER;
    shop_id INTEGER;
BEGIN
    -- Obtener el ID del barbero
    SELECT id INTO barber_user_id FROM users WHERE email = 'barber@barberiaRD.com';
    
    -- Verificar si existe alguna barbería
    SELECT id INTO shop_id FROM barber_shops LIMIT 1;
    
    -- Si hay barbero y barbería, asignar el barbero a la barbería
    IF barber_user_id IS NOT NULL AND shop_id IS NOT NULL THEN
        UPDATE users SET shop_id = shop_id WHERE id = barber_user_id;
    END IF;
END $$;

-- 7. Asignar una barbería al propietario si es necesario
DO $$
DECLARE 
    owner_user_id INTEGER;
    shop_id INTEGER;
BEGIN
    -- Obtener el ID del propietario
    SELECT id INTO owner_user_id FROM users WHERE email = 'owner@barberiaRD.com';
    
    -- Verificar si existe alguna barbería sin propietario
    SELECT id INTO shop_id FROM barber_shops WHERE owner_id IS NULL LIMIT 1;
    
    -- Si hay propietario y barbería, asignar el propietario a la barbería
    IF owner_user_id IS NOT NULL AND shop_id IS NOT NULL THEN
        UPDATE barber_shops SET owner_id = owner_user_id WHERE id = shop_id;
    -- Si no hay barberías sin propietario, pero hay propietario, crear una nueva barbería
    ELSIF owner_user_id IS NOT NULL THEN
        INSERT INTO barber_shops (
            uuid,
            name,
            address,
            owner_id,
            created_at,
            updated_at
        ) VALUES (
            md5(random()::text || clock_timestamp()::text)::uuid,
            'Barbería Demo',
            'Av. Winston Churchill #123, Santo Domingo',
            owner_user_id,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        );
    END IF;
END $$;

-- Eliminar sesiones antiguas para asegurar que todos los usuarios tengan que iniciar sesión de nuevo
TRUNCATE TABLE sessions;

-- Confirmar cambios
SELECT id, name, email, role FROM users WHERE 
email IN ('admin@barberiaRD.com', 'owner@barberiaRD.com', 'barber@barberiaRD.com', 'cliente@barberiaRD.com')
OR role IN ('admin', 'owner');
