import express from 'express';
import {
  getAllProducts,
  getProductsByShop,
  getProductsByBarber,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct
} from '../controllers/productController.js';

const router = express.Router();

// Rutas para productos
router.get('/', getAllProducts);
router.get('/shop/:shopId', getProductsByShop);
router.get('/barber/:barberId', getProductsByBarber);
router.get('/:id', getProductById);
router.post('/', createProduct);
router.put('/:id', updateProduct);
router.delete('/:id', deleteProduct);

export default router;
