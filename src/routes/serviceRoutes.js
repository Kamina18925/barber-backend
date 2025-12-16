import express from 'express';
import {
  getAllServices,
  getServicesByShop,
  getServiceById,
  createService,
  updateService,
  deleteService
} from '../controllers/serviceController.js';

const router = express.Router();

// Rutas para servicios
router.get('/', getAllServices);
router.get('/shop/:shopId', getServicesByShop);
router.get('/:id', getServiceById);
router.post('/', createService);
router.put('/:id', updateService);
router.delete('/:id', deleteService);

export default router;
