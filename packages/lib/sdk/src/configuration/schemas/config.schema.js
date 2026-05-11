import { z } from 'zod';
import { PluginConfigSchema } from '../../plugins/schemas/plugin-config.schema.js';
import { DeploymentConfigSchema } from './deployment.schema.js';
import { buildStorageBackendOptionsSchema } from '@evidence-dev/universal-sql';

export const EvidenceConfigSchema = z.object({
	layout: z.string().or(z.literal(false).default(false)).optional(),
	plugins: PluginConfigSchema,
	deployment: DeploymentConfigSchema.optional().default({}),
	buildOptions: buildStorageBackendOptionsSchema(z)
		.extend({
			batchSize: z.number().min(1).optional()
		})
		.optional()
});

/** @typedef {z.infer<typeof EvidenceConfigSchema>} EvidenceConfig */
