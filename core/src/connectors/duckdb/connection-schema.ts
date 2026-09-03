import { z } from 'zod/v4';
import type { ConnectionFieldMeta } from '../connection-schema';

const meta = (m: ConnectionFieldMeta): ConnectionFieldMeta => m;

export const duckdbBase = z.object({
	type: z.literal('duckdb'),

	path: z
		.string()
		.min(1)
		.default(':memory:')
		.meta(
			meta({
				label: 'Path',
				description:
					'Path to a local .duckdb file, resolved relative to connection.yaml. Defaults to :memory: — an in-process, non-persistent database.',
				category: 'context'
			})
		),

	// Setup SQL runs once when the client starts (INSTALL/LOAD extensions, CREATE
	// SECRET, ATTACH remote databases) — inline or as a file path, not both.
	// resolve.ts reads whichever is present into a single `setupSql` string.
	setup_sql: z
		.string()
		.optional()
		.meta(
			meta({
				label: 'Setup SQL',
				description:
					'SQL run once when the client starts — INSTALL/LOAD extensions, CREATE SECRET, ATTACH remote databases.',
				category: 'context'
			})
		),

	setup_sql_path: z
		.string()
		.optional()
		.meta(
			meta({
				label: 'Setup SQL path',
				description:
					'Path to a SQL file to run once when the client starts, resolved relative to connection.yaml. Alternative to inlining setup_sql.',
				category: 'context',
				cliOnly: true,
				fileRef: { resolveRelativeTo: 'cwd' }
			})
		),

	schemas: z
		.array(z.string().min(1))
		.default([])
		.meta(
			meta({
				label: 'Schemas',
				description: 'Allowlist of schemas exposed to the editor and schema browser.',
				category: 'visibility'
			})
		)
});

export const duckdbConnectionSchema = duckdbBase
	// Inline SQL and a file path for the same setup script are mutually
	// exclusive — providing both is ambiguous about which one wins. Unlike an
	// authGroup, neither is required: no setup script at all is the common case.
	.check((ctx) => {
		const v = ctx.value;
		if (v.setup_sql && v.setup_sql_path) {
			ctx.issues.push({
				code: 'custom',
				message: 'Provide only one of setup_sql or setup_sql_path, not both.',
				path: ['setup_sql_path'],
				input: ctx.value
			});
		}
	});

export type DuckDBConnection = z.infer<typeof duckdbConnectionSchema>;
