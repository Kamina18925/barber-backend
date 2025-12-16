import express from 'express';
import {
  getAllBarberShops,
  getBarberShopsByOwner,
  getBarberShopById,
  createBarberShop,
  updateBarberShop,
  deleteBarberShop
} from '../controllers/barberShopController.js';

const router = express.Router();

// Rutas para barberías
router.get('/', getAllBarberShops);
router.get('/owner/:ownerId', getBarberShopsByOwner);
router.get('/:id', getBarberShopById);
router.post('/', createBarberShop);
router.put('/:id', updateBarberShop);
router.delete('/:id', deleteBarberShop);

export default router;
