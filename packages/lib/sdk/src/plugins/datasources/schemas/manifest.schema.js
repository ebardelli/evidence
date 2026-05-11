import { z } from 'zod';
import { MANIFEST_BACKEND_MODES } from '@evidence-dev/universal-sql';

export const ManifestSchema = z.object({
	backend: z.enum(MANIFEST_BACKEND_MODES).optional(),
	// TODO: Refactor to tables instead of files
	renderedFiles: z.record(z.array(z.string())),
	databaseFile: z
		.object({
			name: z.string(),
			url: z.string(),
			path: z.string().optional()
		})
		.optional(),
	locatedFiles: z.record(z.array(z.string())).optional(),
	locatedSchemas: z.array(z.string()).optional()
});
