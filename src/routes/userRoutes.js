import express from 'express';
import {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  loginUser,
  updateUserProfile,
  changeUserPassword
} from '../controllers/userController.js';

const router = express.Router();

// Rutas para usuarios
router.get('/', getAllUsers);
router.get('/:id', getUserById);
router.post('/', createUser);
router.put('/:id/profile', updateUserProfile);
router.put('/:id/change-password', changeUserPassword);
router.put('/:id', updateUser);
router.delete('/:id', deleteUser);
router.post('/login', loginUser);

export default router;
