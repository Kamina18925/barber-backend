import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Configurar Express
const app = express();
const PORT = 3001; // Puerto diferente para no interferir con el servidor principal

// Obtener __dirname en ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configurar directorio de uploads
const UPLOAD_DIR = path.join(__dirname, '../uploads/test');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Configurar multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const upload = multer({ storage });

// Ruta para servir archivos estáticos
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Ruta para probar carga de archivos
app.post('/upload', upload.single('image'), (req, res) => {
  console.log('Recibiendo solicitud de carga en el servidor de prueba');
  
  if (!req.file) {
    return res.status(400).json({ error: 'No se recibió ningún archivo' });
  }
  
  console.log('Archivo recibido:', {
    filename: req.file.filename,
    size: req.file.size,
    path: req.file.path
  });
  
  res.json({
    success: true,
    url: `/uploads/test/${req.file.filename}`,
    filename: req.file.filename,
    size: req.file.size
  });
});

// Ruta principal con un formulario simple
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Prueba de Carga</title>
      <style>
        body { font-family: Arial; max-width: 600px; margin: 0 auto; padding: 20px; }
        h1 { color: #333; }
        .form-group { margin-bottom: 15px; }
        button { padding: 10px 15px; background: #4CAF50; color: white; border: none; cursor: pointer; }
        #result { margin-top: 20px; padding: 10px; border: 1px solid #ddd; min-height: 100px; }
        img { max-width: 100%; max-height: 300px; margin-top: 15px; }
      </style>
    </head>
    <body>
      <h1>Prueba de Carga de Imágenes</h1>
      
      <div class="form-group">
        <label for="imageFile">Selecciona una imagen:</label>
        <input type="file" id="imageFile" accept="image/*">
      </div>
      
      <button id="uploadBtn">Subir Imagen</button>
      
      <div id="result"></div>
      
      <script>
        document.getElementById('uploadBtn').addEventListener('click', async () => {
          const fileInput = document.getElementById('imageFile');
          const resultDiv = document.getElementById('result');
          
          if (!fileInput.files.length) {
            resultDiv.innerHTML = '<p style="color: red">Por favor selecciona una imagen primero</p>';
            return;
          }
          
          const file = fileInput.files[0];
          resultDiv.innerHTML = '<p>Subiendo imagen...</p>';
          
          try {
            const formData = new FormData();
            formData.append('image', file);
            
            const response = await fetch('/upload', {
              method: 'POST',
              body: formData
            });
            
            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(\`Error \${response.status}: \${errorText}\`);
            }
            
            const data = await response.json();
            
            resultDiv.innerHTML = \`
              <p style="color: green">Imagen subida con éxito!</p>
              <p>Detalles:</p>
              <pre>\${JSON.stringify(data, null, 2)}</pre>
              <img src="\${data.url}" alt="Imagen subida">
            \`;
          } catch (error) {
            console.error('Error:', error);
            resultDiv.innerHTML = \`<p style="color: red">Error: \${error.message}</p>\`;
          }
        });
      </script>
    </body>
    </html>
  `);
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor de prueba ejecutándose en http://localhost:${PORT}`);
});

console.log('Script de prueba iniciado. Visita http://localhost:3001 para probar la carga de imágenes.');
