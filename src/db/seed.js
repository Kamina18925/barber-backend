import bcrypt from 'bcrypt';
import pool from './connection.js';
import dotenv from 'dotenv';

dotenv.config();

// Sample data for seeding
const seedData = async () => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    console.log('Starting database seed...');
    
    // Hash passwords for users
    const saltRounds = 10;
    const password = await bcrypt.hash('password123', saltRounds);
    
    // Insert users
    console.log('Seeding users...');
    const userInserts = [
      // Clients
      ['Ana Pérez', 'client@example.com', password, '809-111-1111', 'client'],
      ['Carlos Cliente', 'carlos@example.com', password, '809-555-5555', 'client'],
      
      // Barbers
      ['Juan Rodríguez', 'barber@example.com', password, '809-222-2222', 'barber'],
      ['Pedro Martínez', 'pedro@example.com', password, '809-444-4444', 'barber'],
      ['Luis Gómez', 'luis@example.com', password, '809-777-7777', 'barber'],
      
      // Owners
      ['Laura Dueña', 'owner@example.com', password, '809-333-3333', 'owner'],
      ['Sofía Dueña', 'sofia@example.com', password, '809-666-6666', 'owner']
    ];
    
    for (const [name, email, password_hash, phone, role] of userInserts) {
      await client.query(
        'INSERT INTO users (name, email, password_hash, phone, role) VALUES ($1, $2, $3, $4, $5) RETURNING user_id',
        [name, email, password_hash, phone, role]
      );
    }
    
    // Get user IDs for reference
    const { rows: users } = await client.query('SELECT user_id, name, email, role FROM users');
    const getUser = (email) => users.find(u => u.email === email);
    
    // Insert barbershops
    console.log('Seeding barbershops...');
    const shopInserts = [
      [getUser('owner@example.com').user_id, 'Barbería Moderna RD', 'Av. Winston Churchill 1020, Piantini', 'Santo Domingo', '809-555-0101'],
      [getUser('sofia@example.com').user_id, 'El Rincón del Barbero Clásico', 'Calle El Sol #45, Centro Ciudad', 'Santiago', '829-555-0202']
    ];
    
    const shopIds = [];
    for (const [owner_id, name, address, city, phone] of shopInserts) {
      const { rows } = await client.query(
        'INSERT INTO barbershops (owner_id, name, address, city, phone) VALUES ($1, $2, $3, $4, $5) RETURNING shop_id',
        [owner_id, name, address, city, phone]
      );
      shopIds.push(rows[0].shop_id);
    }
    
    // Insert master services
    console.log('Seeding master services...');
    const serviceInserts = [
      ['Corte de Pelo Clásico Caballero', 'Corte tradicional, pulido y profesional.', 550, 30, true],
      ['Corte Degradado Moderno (Fade)', 'Incluye diseño de contornos y técnica de degradado a elección.', 750, 50, true],
      ['Afeitado Clásico Premium', 'Experiencia de afeitado tradicional para una piel suave y relajada.', 600, 40, true],
      ['Diseño y Perfilado de Barba', 'Definición, recorte y estilo para tu barba, con productos de calidad.', 400, 25, true],
      ['Corte Infantil (Hasta 12 años)', 'Cortes divertidos y a la moda para los más pequeños.', 450, 30, true],
      ['Tratamiento Capilar Hidratante', 'Mascarilla y tratamiento para revitalizar el cabello.', 800, 45, true]
    ];
    
    for (const [name, description, base_price, base_duration_minutes, is_global] of serviceInserts) {
      await client.query(
        'INSERT INTO masterservices (name, description, base_price, base_duration_minutes, is_global) VALUES ($1, $2, $3, $4, $5)',
        [name, description, base_price, base_duration_minutes, is_global]
      );
    }
    
    // Get service IDs
    const { rows: services } = await client.query('SELECT master_service_id, name FROM masterservices');
    
    // Assign barbers to shops
    console.log('Assigning barbers to shops...');
    await client.query(
      'UPDATE users SET shop_id = $1 WHERE email IN ($2, $3)',
      [shopIds[0], 'barber@example.com', 'pedro@example.com']
    );
    
    await client.query(
      'UPDATE users SET shop_id = $1 WHERE email = $2',
      [shopIds[1], 'luis@example.com']
    );
    
    // Assign services to shops
    console.log('Assigning services to shops...');
    for (const service of services) {
      // First shop gets all services
      await client.query(
        'INSERT INTO shopmasterservices (shop_id, master_service_id) VALUES ($1, $2)',
        [shopIds[0], service.master_service_id]
      );
      
      // Second shop gets a subset of services
      if (['Corte de Pelo Clásico Caballero', 'Afeitado Clásico Premium', 'Diseño y Perfilado de Barba', 'Corte Infantil (Hasta 12 años)'].includes(service.name)) {
        await client.query(
          'INSERT INTO shopmasterservices (shop_id, master_service_id) VALUES ($1, $2)',
          [shopIds[1], service.master_service_id]
        );
      }
    }
    
    // Set up barber availability
    console.log('Setting up barber availability...');
    const barberAvailability = [
      // Juan (barber@example.com)
      [getUser('barber@example.com').user_id, 'L', '09:00', '19:00'],
      [getUser('barber@example.com').user_id, 'M', '09:00', '19:00'],
      [getUser('barber@example.com').user_id, 'X', '09:00', '19:00'],
      [getUser('barber@example.com').user_id, 'J', '09:00', '20:00'],
      [getUser('barber@example.com').user_id, 'V', '09:00', '20:00'],
      [getUser('barber@example.com').user_id, 'S', '10:00', '18:00'],
      
      // Pedro (pedro@example.com)
      [getUser('pedro@example.com').user_id, 'L', '10:00', '18:00'],
      [getUser('pedro@example.com').user_id, 'M', '10:00', '18:00'],
      [getUser('pedro@example.com').user_id, 'J', '10:00', '19:00'],
      [getUser('pedro@example.com').user_id, 'V', '10:00', '19:00'],
      [getUser('pedro@example.com').user_id, 'S', '09:00', '17:00'],
      
      // Luis (luis@example.com)
      [getUser('luis@example.com').user_id, 'L', '10:00', '18:00'],
      [getUser('luis@example.com').user_id, 'M', '10:00', '18:00'],
      [getUser('luis@example.com').user_id, 'J', '10:00', '19:00'],
      [getUser('luis@example.com').user_id, 'V', '10:00', '19:00']
    ];
    
    for (const [barber_id, day_of_week, start_time_local, end_time_local] of barberAvailability) {
      await client.query(
        'INSERT INTO barberavailability (barber_id, day_of_week, start_time_local, end_time_local) VALUES ($1, $2, $3, $4)',
        [barber_id, day_of_week, start_time_local, end_time_local]
      );
    }
    
    // Set up shop opening hours
    console.log('Setting up shop opening hours...');
    const shopHours = [
      // Shop 1
      [shopIds[0], 'L', '09:00', '19:00', false],
      [shopIds[0], 'M', '09:00', '19:00', false],
      [shopIds[0], 'X', '09:00', '19:00', false],
      [shopIds[0], 'J', '09:00', '20:00', false],
      [shopIds[0], 'V', '09:00', '20:00', false],
      [shopIds[0], 'S', '10:00', '18:00', false],
      [shopIds[0], 'D', null, null, true],
      
      // Shop 2
      [shopIds[1], 'L', '10:00', '18:00', false],
      [shopIds[1], 'M', '10:00', '18:00', false],
      [shopIds[1], 'X', null, null, true],
      [shopIds[1], 'J', '10:00', '19:00', false],
      [shopIds[1], 'V', '10:00', '19:00', false],
      [shopIds[1], 'S', '09:00', '17:00', false],
      [shopIds[1], 'D', null, null, true]
    ];
    
    for (const [shop_id, day_of_week, opening_time, closing_time, is_closed] of shopHours) {
      await client.query(
        'INSERT INTO shopopeninghours (shop_id, day_of_week, opening_time, closing_time, is_closed) VALUES ($1, $2, $3, $4, $5)',
        [shop_id, day_of_week, opening_time, closing_time, is_closed]
      );
    }
    
    // Add shop photos
    console.log('Adding shop photos...');
    const shopPhotos = [
      [shopIds[0], 'https://images.unsplash.com/photo-1585740090496-268f50a13893?q=80&w=800&auto=format&fit=crop', true],
      [shopIds[0], 'https://images.unsplash.com/photo-1605497788018-069939359192?q=80&w=800&auto=format&fit=crop', false],
      [shopIds[0], 'https://images.unsplash.com/photo-1599351549021-98654000b6b6?q=80&w=800&auto=format&fit=crop', false],
      [shopIds[1], 'https://images.unsplash.com/photo-1621605815971-e07109951330?q=80&w=800&auto=format&fit=crop', true],
      [shopIds[1], 'https://images.unsplash.com/photo-1567894340347-10isefefc653?q=80&w=800&auto=format&fit=crop', false]
    ];
    
    for (const [shop_id, photo_url, is_primary] of shopPhotos) {
      await client.query(
        'INSERT INTO shopphotos (shop_id, photo_url, is_primary) VALUES ($1, $2, $3)',
        [shop_id, photo_url, is_primary]
      );
    }
    
    // Add products
    console.log('Adding products...');
    const products = [
      // Shop 1 global products
      [shopIds[0], null, 'Cera Moldeadora Max Pro', 'Cera de fijación fuerte para estilos definidos y duraderos. Acabado mate.', 450, 30, 'https://images.unsplash.com/photo-1580870069867-74c57ee130b0?q=80&w=400&auto=format&fit=crop', 'Fijadores'],
      [shopIds[0], null, 'Shampoo Anticaída Forte', 'Shampoo especializado para fortalecer el cabello y prevenir la caída.', 750, 15, 'https://images.unsplash.com/photo-1620916298398-1c9a095e883c?q=80&w=400&auto=format&fit=crop', 'Cuidado Capilar'],
      
      // Barber personal products
      [shopIds[0], getUser('barber@example.com').user_id, 'Aceite para Barba "El Leñador"', 'Mezcla artesanal de aceites naturales para una barba suave y nutrida. Aroma a cedro.', 600, 12, 'https://images.unsplash.com/photo-1631779020030-bfe01ec72a04?q=80&w=400&auto=format&fit=crop', 'Cuidado de Barba'],
      [shopIds[0], getUser('pedro@example.com').user_id, 'Crema de Afeitar "Precisión"', 'Crema rica para un afeitado al ras y sin irritación. Ideal para pieles sensibles.', 300, 25, 'https://images.unsplash.com/photo-1600071996969-f084b5f80b97?q=80&w=400&auto=format&fit=crop', 'Afeitado'],
      
      // Shop 2 global products
      [shopIds[1], null, 'Tónico Capilar Clásico', 'Tónico revitalizante para el cuero cabelludo. Fragancia tradicional.', 380, 18, 'https://plus.unsplash.com/premium_photo-1679864253060-9c6027997983?q=80&w=400&auto=format&fit=crop', 'Tratamientos']
    ];
    
    for (const [shop_id, barber_id, name, description, price, stock, photo_url, category] of products) {
      await client.query(
        'INSERT INTO products (shop_id, barber_id, name, description, price, stock, photo_url, category) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [shop_id, barber_id, name, description, price, stock, photo_url, category]
      );
    }
    
    // Create barber services
    console.log('Setting up barber services...');
    
    // Get service IDs by name
    const getServiceId = (name) => {
      const service = services.find(s => s.name === name);
      return service ? service.master_service_id : null;
    };
    
    const barberServices = [
      // Juan (barber@example.com)
      [getUser('barber@example.com').user_id, getServiceId('Corte de Pelo Clásico Caballero'), 'Corte Clásico Maestro Juan', 'Mi toque especial en el corte clásico.', 600, 35],
      [getUser('barber@example.com').user_id, getServiceId('Afeitado Clásico Premium'), null, null, null, null],
      [getUser('barber@example.com').user_id, null, 'Masaje Capilar Profundo', 'Relajación y nutrición intensiva para el cuero cabelludo.', 450, 25],
      
      // Pedro (pedro@example.com)
      [getUser('pedro@example.com').user_id, getServiceId('Corte de Pelo Clásico Caballero'), null, null, null, null],
      [getUser('pedro@example.com').user_id, getServiceId('Corte Degradado Moderno (Fade)'), 'Degradado Pro Pedro', null, 780, 55],
      [getUser('pedro@example.com').user_id, getServiceId('Diseño y Perfilado de Barba'), null, null, null, null],
      
      // Luis (luis@example.com)
      [getUser('luis@example.com').user_id, getServiceId('Afeitado Clásico Premium'), null, null, 550, null],
      [getUser('luis@example.com').user_id, getServiceId('Diseño y Perfilado de Barba'), null, 'El mejor cuidado para tu barba, garantizado.', null, null],
      [getUser('luis@example.com').user_id, getServiceId('Corte Infantil (Hasta 12 años)'), null, null, null, null]
    ];
    
    for (const [barber_id, master_service_id, personal_name, personal_description, price_by_barber, duration_by_barber] of barberServices) {
      await client.query(
        'INSERT INTO barberservices (barber_id, master_service_id, personal_name, personal_description, price_by_barber, duration_by_barber) VALUES ($1, $2, $3, $4, $5, $6)',
        [barber_id, master_service_id, personal_name, personal_description, price_by_barber, duration_by_barber]
      );
    }
    
    // Create some sample appointments
    console.log('Creating sample appointments...');
    
    // Get current date and adjust for sample appointments
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    // Function to format date for PostgreSQL
    const formatDate = (date) => {
      return date.toISOString();
    };
    
   // Get barber service IDs
const { rows: barberServiceRows } = await client.query(
  'SELECT barber_service_id, barber_id, master_service_id FROM barberservices'
);
    
    // Helper to find barber service ID
    const getBarberServiceId = (barberId, masterServiceId) => {
      const service = barberServiceRows.find(
        s => s.barber_id === barberId && s.master_service_id === masterServiceId
      );
      return service ? service.barber_service_id : null;
    };
    
    // Sample appointments
    const appointments = [
      // Upcoming appointments
      [
        getUser('client@example.com').user_id,
        shopIds[0],
        getUser('barber@example.com').user_id,
        getBarberServiceId(getUser('barber@example.com').user_id, getServiceId('Corte de Pelo Clásico Caballero')),
        formatDate(new Date(today.setHours(today.getHours() + 1, 0, 0, 0))),
        formatDate(new Date(today.setHours(today.getHours() + 1, 35, 0, 0))),
        'confirmed',
        'Llegaré puntual.',
        null,
        600,
        '809-111-1111'
      ],
      [
        getUser('carlos@example.com').user_id,
        shopIds[0],
        getUser('pedro@example.com').user_id,
        getBarberServiceId(getUser('pedro@example.com').user_id, getServiceId('Corte Degradado Moderno (Fade)')),
        formatDate(new Date(tomorrow.setHours(14, 30, 0, 0))),
        formatDate(new Date(tomorrow.setHours(15, 25, 0, 0))),
        'confirmed',
        null,
        'Cliente prefiere muy corto a los lados',
        780,
        '809-555-5555'
      ],
      
      // Completed appointments
      [
        getUser('client@example.com').user_id,
        shopIds[0],
        getUser('barber@example.com').user_id,
        getBarberServiceId(getUser('barber@example.com').user_id, getServiceId('Corte de Pelo Clásico Caballero')),
        formatDate(new Date(yesterday.setHours(16, 0, 0, 0))),
        formatDate(new Date(yesterday.setHours(16, 35, 0, 0))),
        'completed',
        null,
        'Buen cliente, propina generosa.',
        600,
        '809-111-1111'
      ]
    ];
    
    for (const [
      client_id, shop_id, barber_id, barber_service_id, start_time, end_time,
      status, notes_client, notes_barber, price_at_booking, client_phone_at_booking
    ] of appointments) {
      await client.query(
        `INSERT INTO appointments 
         (client_id, shop_id, barber_id, barber_service_id, start_time, end_time, status, 
          notes_client, notes_barber, price_at_booking, client_phone_at_booking)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          client_id, shop_id, barber_id, barber_service_id, start_time, end_time,
          status, notes_client, notes_barber, price_at_booking, client_phone_at_booking
        ]
      );
    }
    
    // Add some reviews
    console.log('Adding reviews...');
    const reviews = [
      [shopIds[0], getUser('client@example.com').user_id, null, 5, 'Excelente servicio y atención por parte de Juan. Siempre salgo satisfecho.'],
      [shopIds[0], getUser('carlos@example.com').user_id, null, 4, 'Muy buen corte con Pedro, el ambiente es genial. A veces hay que esperar un poco.'],
      [shopIds[1], getUser('client@example.com').user_id, null, 4, 'Buen ambiente tradicional, Luis es muy profesional con la barba.']
    ];
    
    for (const [shop_id, user_id, appointment_id, rating, comment] of reviews) {
      await client.query(
        'INSERT INTO reviews (shop_id, user_id, appointment_id, rating, comment) VALUES ($1, $2, $3, $4, $5)',
        [shop_id, user_id, appointment_id, rating, comment]
      );
    }
    
    // Update shop ratings based on reviews
    console.log('Updating shop ratings...');
    await client.query(`
      UPDATE barbershops b
      SET rating_avg = (
        SELECT COALESCE(AVG(rating)::numeric(2,1), 0.0)
        FROM reviews r
        WHERE r.shop_id = b.shop_id
      )
    `);
    
    await client.query('COMMIT');
    console.log('Database seed completed successfully!');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error seeding database:', error);
    throw error;
  } finally {
    client.release();
  }
};

// Run the seed function
seedData()
  .then(() => {
    console.log('Seed script completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Seed script failed:', error);
    process.exit(1);
  });