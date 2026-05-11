import { STORAGE_BACKEND_MODES } from './index.js';

/**
 * Build the shared backend options schema using the caller's Zod instance.
 *
 * @param {any} z
 */
export const buildStorageBackendOptionsSchema = (z) =>
	z.object({
		storageMode: z.enum(STORAGE_BACKEND_MODES).optional(),
		database: z.string().optional(),
		token: z.string().optional(),
		readScalingToken: z.string().optional()
	});
