import nodemailer from 'nodemailer';
import { env } from '../../config/env';

export interface EmailPayload { to: string; subject: string; text: string }

export async function sendEmail(payload: EmailPayload): Promise<void> {
  if (!env.SMTP_URL) throw new Error('EMAIL_TRANSPORT_UNAVAILABLE');
  let smtpUrl: URL;
  try {
    smtpUrl = new URL(env.SMTP_URL);
    if (!['smtp:', 'smtps:'].includes(smtpUrl.protocol)) throw new Error('INVALID_PROTOCOL');
  } catch {
    throw new Error('EMAIL_TRANSPORT_CONFIGURATION_INVALID');
  }
  // Nodemailer reads transport options from the SMTP URL query. Override any
  // configured timeout so a stalled provider cannot monopolize a worker.
  smtpUrl.searchParams.set('connectionTimeout', '10000');
  smtpUrl.searchParams.set('greetingTimeout', '10000');
  smtpUrl.searchParams.set('socketTimeout', '15000');
  const transport = nodemailer.createTransport(smtpUrl.toString(), { from: env.EMAIL_FROM });
  try {
    await transport.sendMail({ to: payload.to, subject: payload.subject, text: payload.text, disableFileAccess: true, disableUrlAccess: true });
  } catch {
    // Provider errors may include recipients or message content. Jobs retain only this code.
    throw new Error('EMAIL_DELIVERY_FAILED');
  } finally {
    transport.close();
  }
}
