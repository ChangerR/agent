import { z } from 'zod';
export {
  chatSchema,
  descriptionSchema,
  streamSchema,
} from '../../src/providers/bridge-protocol.js';
export const REMOTE_VERSION = 1;
export const sshTargetSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/);
export const sshHostInputSchema = z
  .object({ target: sshTargetSchema, name: z.string().trim().min(1).max(100).optional() })
  .strict();
export type SshHostInput = z.infer<typeof sshHostInputSchema>;
export const openRemoteProjectSchema = z
  .object({
    hostId: z.string().min(1).max(100),
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((p) => p.startsWith('/') && !/[\x00-\x1f]/.test(p)),
    mappings: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)).default({}),
    newSession: z.boolean().optional(),
  })
  .strict();
export type OpenRemoteProjectInput = z.infer<typeof openRemoteProjectSchema>;
export const newSessionSchema = z.object({ projectId: z.string().min(1).max(4096) }).strict();
export const newProjectSchema = z
  .object({
    location: z.enum(['local', 'ssh']),
    hostId: z.string().min(1).max(100).optional(),
    parentPath: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => !/[\x00-\x1f]/.test(v)),
    name: z
      .string()
      .min(1)
      .max(100)
      .refine(
        (v) =>
          !/[\\/<>:"|?*\x00-\x1f]/.test(v) &&
          !/[. ]$/.test(v) &&
          v !== '.' &&
          v !== '..' &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v),
      ),
  })
  .strict()
  .refine((v) => v.location === 'local' || !!v.hostId);
export type NewProjectInput = z.infer<typeof newProjectSchema>;
export const sshProjectSchema = z
  .object({
    target: sshTargetSchema,
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((p) => p.startsWith('/') && !/[\x00-\x1f]/.test(p)),
    mappings: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)).default({}),
  })
  .strict();
export type SshProjectInput = z.infer<typeof sshProjectSchema>;
