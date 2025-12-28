import express from 'express';
import {
  getAllBarberShops,
  getBarberShopsByOwner,
  getBarberShopById,
  getBarberShopReviews,
  addBarberShopReview,
  createBarberShop,
  updateBarberShop,
  deleteBarberShop
} from '../controllers/barberShopController.js';

const router = express.Router();

// Rutas para barberías
router.get('/', getAllBarberShops);
router.get('/owner/:ownerId', getBarberShopsByOwner);
router.get('/:id/reviews', getBarberShopReviews);
router.post('/:id/reviews', addBarberShopReview);
router.get('/:id', getBarberShopById);
router.post('/', createBarberShop);
router.put('/:id', updateBarberShop);
router.delete('/:id', deleteBarberShop);

export default router;
