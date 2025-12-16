import express from 'express';
import {
  archiveConversationForUser,
  createMessage,
  getOrCreateDirectConversation,
  getMessagesByConversation,
  getOrCreateConversationForAppointment,
  getUserConversations,
  getOwnerConversations,
  markMessagesAsReadForConversation,
} from '../controllers/chatController.js';

const router = express.Router();

// Crear mensaje en una conversación existente
router.post('/messages', createMessage);

// Obtener mensajes de una conversación
router.get('/conversations/:conversationId/messages', getMessagesByConversation);

// Obtener o crear conversación cliente-barbero asociada a una cita
router.get('/conversations/by-appointment/:appointmentId', getOrCreateConversationForAppointment);

// Obtener o crear conversación directa cliente-barbero (sin cita)
router.post('/conversations/direct', getOrCreateDirectConversation);

// Listar conversaciones de un usuario (cliente o barbero)
router.get('/conversations/user/:userId', getUserConversations);

// Archivar (eliminar individual) una conversación para un usuario
router.post('/conversations/:conversationId/archive', archiveConversationForUser);

// Marcar mensajes como leídos para un usuario en una conversación
router.post('/conversations/:conversationId/mark-read', markMessagesAsReadForConversation);

// Listar conversaciones para un dueño (owner)
router.get('/owner/:ownerId/conversations', getOwnerConversations);

export default router;
