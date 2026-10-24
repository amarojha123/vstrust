import type { Request, Response, CookieOptions } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import * as auth from '../services/auth.service';
import { emailRequestSchema, loginSchema, registerSchema, resetSchema, tokenSchema } from '../validators/auth.validators';

const cookieOptions: CookieOptions = { secure: env.COOKIE_SECURE, sameSite: 'lax', path: '/' };
function setCredentials(res: Response, credentials: { accessToken: string; csrfToken: string; expiresAt: Date }) {
  res.cookie('tm_session', credentials.accessToken, { ...cookieOptions, httpOnly: true, expires: credentials.expiresAt });
  res.cookie('tm_csrf', credentials.csrfToken, { ...cookieOptions, httpOnly: false, expires: credentials.expiresAt });
  res.setHeader('Cache-Control', 'no-store');
}
function clearCredentials(res: Response) {
  res.clearCookie('tm_session', { ...cookieOptions, httpOnly: true });
  res.clearCookie('tm_csrf', { ...cookieOptions, httpOnly: false });
}

export const authController = {
  register: async (req: Request, res: Response) => {
    const user = await auth.register(registerSchema.parse(req.body), req.correlationId);
    res.status(201).json({ data: { user, message: 'Check your email to verify your account.' } });
  },
  login: async (req: Request, res: Response) => {
    const result = await auth.login(loginSchema.parse(req.body), req.correlationId);
    setCredentials(res, result);
    res.json({ data: result });
  },
  logout: async (req: Request, res: Response) => {
    await auth.logout(req.auth!.userId, req.auth!.sessionId, req.correlationId);
    clearCredentials(res);
    res.status(204).send();
  },
  me: async (req: Request, res: Response) => { res.setHeader('Cache-Control', 'no-store'); res.json({ data: await auth.me(req.auth!.userId) }); },
  forgotPassword: async (req: Request, res: Response) => {
    const { email } = emailRequestSchema.parse(req.body);
    await auth.requestEmailAction(email, 'reset_password', req.correlationId);
    res.status(202).json({ data: { message: 'If an active account exists, a password reset email will be sent.' } });
  },
  resendVerification: async (req: Request, res: Response) => {
    const { email } = emailRequestSchema.parse(req.body);
    await auth.requestEmailAction(email, 'verify_email', req.correlationId);
    res.status(202).json({ data: { message: 'If an unverified account exists, a verification email will be sent.' } });
  },
  verifyEmail: async (req: Request, res: Response) => {
    const { token } = tokenSchema.parse(req.body);
    await auth.verifyEmail(token, req.correlationId);
    res.json({ data: { message: 'Email verified.' } });
  },
  resetPassword: async (req: Request, res: Response) => {
    const { token, password } = resetSchema.parse(req.body);
    await auth.resetPassword(token, password, req.correlationId);
    clearCredentials(res);
    res.json({ data: { message: 'Password reset. Sign in with your new password.' } });
  },
  refresh: async (req: Request, res: Response) => {
    const result = await auth.refreshSession(req.auth!.userId, req.auth!.sessionId, req.correlationId);
    setCredentials(res, result);
    res.json({ data: result });
  },
  sessions: async (req: Request, res: Response) => { res.json({ data: await auth.listSessions(req.auth!.userId, req.auth!.sessionId) }); },
  revokeSession: async (req: Request, res: Response) => {
    const id = z.string().regex(/^[a-f\d]{24}$/i).parse(req.params.sessionId);
    await auth.revokeSession(req.auth!.userId, id, req.correlationId);
    if (id === req.auth!.sessionId) clearCredentials(res);
    res.status(204).send();
  },
};
