import express from 'express';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import {
  getAllUsers,
  getUserById,
  getCurrentUserProfile,
  getVisibleUsers,
  getPublicBarbersByShop,
  createUser,
  updateUser,
  deleteUser,
  loginUser,
  updateUserProfile,
  changeUserPassword,
  deleteOwnerAccount
} from '../controllers/userController.js';

const router = express.Router();

// Rutas para usuarios
router.post('/login', loginUser);

router.post('/', createUser);

router.get('/barbers/shop/:shopId', getPublicBarbersByShop);

router.get('/', authenticateToken, authorizeRoles('admin'), getAllUsers);
router.get('/profile', authenticateToken, getCurrentUserProfile);
router.get('/visible', authenticateToken, getVisibleUsers);
router.get('/:id', authenticateToken, getUserById);
router.put('/:id/profile', authenticateToken, updateUserProfile);
router.put('/:id/change-password', authenticateToken, changeUserPassword);
router.delete('/:id/owner-account', authenticateToken, deleteOwnerAccount);

router.put('/:id', authenticateToken, authorizeRoles('admin', 'owner'), updateUser);
router.delete('/:id', authenticateToken, authorizeRoles('admin', 'owner'), deleteUser);

export default router;
