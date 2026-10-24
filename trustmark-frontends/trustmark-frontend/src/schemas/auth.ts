import { z } from 'zod'

const emailSchema = z.string().trim().email('Enter a valid work email').max(254, 'Use at most 254 characters').toLowerCase()
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(128, 'Use at most 128 characters'),
})
export const registerSchema = z.object({
  name: z.string().trim().min(1, 'Enter your full name').max(100, 'Use at most 100 characters'),
  email: emailSchema,
  password: z.string().min(12, 'Use at least 12 characters').max(128, 'Use at most 128 characters'),
  confirmPassword: z.string().min(1, 'Confirm your password'),
}).refine(v => v.password === v.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' })
export type LoginInput = z.infer<typeof loginSchema>
export type RegisterInput = z.infer<typeof registerSchema>
