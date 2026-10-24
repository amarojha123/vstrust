import { Router } from 'express';
import { authController as controller } from '../controllers/auth.controller';
import { authenticate } from '../middlewares/security';

export const authRouter = Router();
authRouter.post('/register', controller.register);
authRouter.post('/login', controller.login);
authRouter.post('/forgot-password', controller.forgotPassword);
authRouter.post('/reset-password', controller.resetPassword);
authRouter.post('/verify-email', controller.verifyEmail);
authRouter.post('/resend-verification', controller.resendVerification);
authRouter.post('/logout', authenticate, controller.logout);
authRouter.get('/me', authenticate, controller.me);
authRouter.post('/refresh', authenticate, controller.refresh);
authRouter.get('/sessions', authenticate, controller.sessions);
authRouter.delete('/sessions/:sessionId', authenticate, controller.revokeSession);
