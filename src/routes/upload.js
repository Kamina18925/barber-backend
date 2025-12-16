import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';



const router = express.Router();

// Establecer las rutas absolutas
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_BASE_DIR = path.join(__dirname, '../../../uploads');

console.log('Directorio de uploads configurado en:', UPLOADS_BASE_DIR);

// Asegurar que el directorio existe
if (!fs.existsSync(UPLOADS_BASE_DIR)) {
  fs.mkdirSync(UPLOADS_BASE_DIR, { recursive: true });
  console.log('Directorio base de uploads creado');
}

// Asegurar que existen los subdirectorios necesarios
['misc', 'shop', 'profile', 'service', 'product'].forEach(dir => {
  const subDir = path.join(UPLOADS_BASE_DIR, dir);
  if (!fs.existsSync(subDir)) {
    fs.mkdirSync(subDir, { recursive: true });
    console.log(`Subdirectorio ${dir} creado`);
  }
});

// Configuración simplificada de multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Por defecto usar 'misc', a menos que se especifique otro en la ruta
    let folder = 'misc';
    
    // Si la ruta es /shop, usar la carpeta 'shop'
    if (req.originalUrl.includes('/shop')) {
      folder = 'shop';
    }
    
    const uploadPath = path.join(UPLOADS_BASE_DIR, folder);
    console.log(`Guardando archivo en: ${uploadPath}`);
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    // Generar nombre único para evitar colisiones
    const uniquePrefix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const extension = path.extname(file.originalname) || '.jpg';
    const filename = uniquePrefix + extension;
    console.log(`Nombre de archivo generado: ${filename}`);
    cb(null, filename);
  }
});

// Configuración de multer
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  },
  fileFilter: (req, file, cb) => {
    // Permitir solo imágenes
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos de imagen'), false);
    }
  }
});

// Rutas para manejo de uploads - simplificadas

// Ruta principal para subir cualquier imagen - la más utilizada
router.post('/', (req, res) => {
  console.log('Recibiendo solicitud en /api/upload');
  
  // Manejar directamente con single middleware
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('Error en upload:', err);
      return res.status(400).json({ error: err.message || 'Error al subir archivo' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ningún archivo' });
    }
    
    console.log('Archivo recibido:', {
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
      path: req.file.path
    });
    
    // Construir la URL del archivo usando el nombre generado y la carpeta correcta
    const folderName = path.basename(path.dirname(req.file.path));
    const fileUrl = `/uploads/${folderName}/${req.file.filename}`;
    
    // Verificar que el archivo exista físicamente
    if (!fs.existsSync(req.file.path)) {
      console.error(`¡El archivo subido no existe en: ${req.file.path}!`);
      return res.status(500).json({ error: 'Error interno: el archivo no se guardó correctamente' });
    }
    
    console.log(`Archivo guardado exitosamente en: ${req.file.path}`);
    console.log(`URL accesible: ${fileUrl}`);
    
    // Enviar respuesta con URL del archivo
    res.json({
      url: fileUrl,
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype
    });
  });
});

// Ruta específica para subir imágenes de barberías
router.post('/shop', (req, res) => {
  console.log('Recibiendo solicitud para imagen de barbería');
  
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('Error en upload/shop:', err);
      return res.status(400).json({ error: err.message || 'Error al subir imagen de barbería' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ningún archivo' });
    }
    
    console.log('Imagen de barbería recibida:', req.file.filename);
    
    // Construir la URL del archivo
    const fileUrl = `/uploads/shop/${req.file.filename}`;
    
    // Enviar respuesta
    res.json({
      url: fileUrl,
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype
    });
  });
});

// Ruta para subir múltiples imágenes
router.post('/multiple', (req, res) => {
  console.log('Recibiendo solicitud para múltiples imágenes');
  
  upload.array('images', 10)(req, res, (err) => {
    if (err) {
      console.error('Error en upload/multiple:', err);
      return res.status(400).json({ error: err.message || 'Error al subir múltiples imágenes' });
    }
    
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'No se recibió ningún archivo' });
    }
    
    console.log(`Recibidas ${req.files.length} imágenes`);
    
    // Construir las URLs de los archivos
    const filesData = req.files.map(file => ({
      url: `/uploads/misc/${file.filename}`,
      filename: file.filename,
      size: file.size,
      mimetype: file.mimetype
    }));
    
    // Enviar respuesta
    res.json(filesData);
  });
});


// Endpoint para eliminar una imagen
router.delete('/:type/:filename', (req, res) => {
  const { type, filename } = req.params;
  const filePath = path.join(__dirname, '../../../uploads', type, filename);
  
  // Verificar que el archivo existe
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado' });
  }
  
  // Eliminar el archivo
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: 'Archivo eliminado correctamente' });
  } catch (error) {
    console.error('Error al eliminar el archivo:', error);
    res.status(500).json({ error: 'Error al eliminar el archivo' });
  }
});

// Ruta simple de prueba para verificar que el API funciona
router.get('/test', (req, res) => {
  console.log('Ruta de prueba de API accedida');
  res.json({ 
    success: true, 
    message: 'API de carga de imágenes funcionando correctamente',
    timestamp: new Date().toISOString()
  });
});

export default router;