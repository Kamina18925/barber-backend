import express from 'express';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import {
  getOwnerSubscriptionSummary,
  listOwnerPayments,
  listPaymentsAdmin,
  createManualPaymentReport,
  listManualPaymentReports,
  approveManualPaymentReport,
  rejectManualPaymentReport,
  adminActivateSubscription,
  getPaypalConfig,
  paypalCreateOrder,
  paypalCaptureOrder,
  paypalCreateSubscription,
  paypalConfirmSubscription,
  paypalCancelSubscription,
  paypalChangeSubscriptionPlan,
  paypalWebhook,
} from '../controllers/subscriptionController.js';

const router = express.Router();

router.get('/owner/:ownerId', authenticateToken, getOwnerSubscriptionSummary);
router.get('/owner/:ownerId/payments', authenticateToken, listOwnerPayments);
router.post('/manual-report', authenticateToken, createManualPaymentReport);

router.get('/admin/manual-reports', authenticateToken, authorizeRoles('admin'), listManualPaymentReports);
router.post('/admin/manual-reports/:id/approve', authenticateToken, authorizeRoles('admin'), approveManualPaymentReport);
router.post('/admin/manual-reports/:id/reject', authenticateToken, authorizeRoles('admin'), rejectManualPaymentReport);
router.post('/admin/activate', authenticateToken, authorizeRoles('admin'), adminActivateSubscription);
router.get('/admin/payments', authenticateToken, authorizeRoles('admin'), listPaymentsAdmin);

router.get('/paypal/config', getPaypalConfig);
router.post('/paypal/create-order', authenticateToken, paypalCreateOrder);
router.post('/paypal/capture-order', authenticateToken, paypalCaptureOrder);

router.post('/paypal/subscriptions/create', authenticateToken, paypalCreateSubscription);
router.post('/paypal/subscriptions/confirm', authenticateToken, paypalConfirmSubscription);
router.post('/paypal/subscriptions/cancel', authenticateToken, paypalCancelSubscription);
router.post('/paypal/subscriptions/change-plan', authenticateToken, paypalChangeSubscriptionPlan);
router.post('/paypal/webhook', paypalWebhook);

export default router;
