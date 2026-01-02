import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import morgan from 'morgan';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import shopRoutes from './routes/shops.js';
import serviceRoutes from './routes/services.js';
import appointmentRoutes from './routes/appointmentRoutes.js';
import productRoutes from './routes/products.js';
import uploadRoutes from './routes/upload.js';
import chatRoutes from './routes/chatRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import { connectDB } from './db/connection.js';

// Get current file directory (ESM equivalent of __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
// Añadir soporte para datos codificados en URL (formularios)
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/shops', shopRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/products', productRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/notifications', notificationRoutes);

// Función para crear directorios de uploads si no existen
const setupUploadDirectories = () => {
  const baseUploadDir = path.join(__dirname, '../../uploads');
  
  // Crear el directorio base de uploads si no existe
  if (!fs.existsSync(baseUploadDir)) {
    fs.mkdirSync(baseUploadDir, { recursive: true });
  }
  
  // Crear subdirectorios para diferentes tipos de archivos
  const categories = ['profile', 'product', 'shop', 'service', 'misc'];
  categories.forEach(category => {
    const categoryDir = path.join(baseUploadDir, category);
    if (!fs.existsSync(categoryDir)) {
      fs.mkdirSync(categoryDir, { recursive: true });
    }
  });
  
  // Crear un index.html simple en cada directorio para evitar problemas de navegación
  categories.forEach(category => {
    const indexPath = path.join(baseUploadDir, category, 'index.html');
    if (!fs.existsSync(indexPath)) {
      fs.writeFileSync(indexPath, '<html><body><h1>Directory Listing Not Allowed</h1></body></html>');
    }
  });
  
  console.log('Upload directories setup completed');
};

// Configurar directorios de uploads al iniciar
setupUploadDirectories();

// Servir imágenes subidas
app.use('/uploads', express.static(path.join(__dirname, '../../uploads')));

// Middleware para logs de acceso a imágenes
app.use('/uploads', (req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Accessed: ${req.originalUrl}`);
  next();
});

// Serve static frontend in production
if (process.env.NODE_ENV === 'production') {
  const frontendBuildPath = path.join(__dirname, '../../frontend/dist');
  app.use(express.static(frontendBuildPath));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendBuildPath, 'index.html'));
  });
}

// Connect to database and start server
const startServer = async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();