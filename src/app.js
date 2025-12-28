import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import productRoutes from './routes/productRoutes.js';
import userRoutes from './routes/userRoutes.js';
import barberShopRoutes from './routes/barberShopRoutes.js';
import serviceRoutes from './routes/serviceRoutes.js';
import appointmentRoutes from './routes/appointmentRoutes.js';
import authRoutes from './routes/auth.js';
import uploadRoutes from './routes/upload.js';
import barberServicesRoutes from './routes/barberServicesRoutes.js';
import barberServicesSingleRoutes from './routes/barberServicesSingleRoutes.js';
import barberAvailabilityRoutes from './routes/barberAvailabilityRoutes.js';
import barberBreaksRoutes from './routes/barberBreaksRoutes.js';
import timeRoutes from './routes/timeRoutes.js';
import chatRoutes from './routes/chatRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(cors());
// Aumentar límite de tamaño del JSON para permitir imágenes/base64 más grandes
app.use(express.json({ limit: '10mb' }));

 app.use('/uploads', express.static(path.join(__dirname, '../../uploads')));

// Rutas API
app.use('/api/auth', authRoutes); // registro y login
app.use('/api/products', productRoutes);
app.use('/api/users', userRoutes);
app.use('/api/barbershops', barberShopRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/barber-services', barberServicesRoutes);
app.use('/api/barber-services-single', barberServicesSingleRoutes);
app.use('/api/barber-availability', barberAvailabilityRoutes);
app.use('/api/barber-breaks', barberBreaksRoutes);
app.use('/api/time', timeRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/notifications', notificationRoutes);

// Ruta de prueba
app.get('/api/test', (req, res) => {
  res.json({ message: 'API funcionando correctamente' });
});

// Manejo de errores
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Error del servidor', error: err.message });
});

export default app;
