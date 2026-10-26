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
		),

	// Sandboxing applied after setup_sql runs — see cli/cli/connection/duckdb.ts's
	// lockInstance. Local entries resolve relative to connection.yaml; URL
	// prefixes (gs://, s3://, https://) pass through as written.
	allowed_paths: z
		.array(z.string().min(1))
		.default([])
		.meta(
			meta({
				label: 'Allowed paths',
				description:
					'Directory prefixes (local or remote, e.g. gs://bucket/) that queries may read once the instance is locked. Becomes DuckDB allowed_directories.',
				category: 'context',
				cliOnly: true
			})
		),

	lock: z
		.boolean()
		.optional()
		.meta(
			meta({
				label: 'Lock',
				description:
					'Lock the instance after setup_sql: no file access outside allowed_paths, no extension loading, no settings changes, single SELECT statements only. Defaults to on in `evidence serve`, off in `evidence dev`.',
				category: 'context',
				cliOnly: true
			})
		),

	query_timeout_seconds: z
		.number()
		.positive()
		.default(120)
		.meta(
			meta({
				label: 'Query timeout (seconds)',
				description: 'Interrupt a locked-instance query that runs longer than this.',
				category: 'context',
				cliOnly: true
			})
		),

	max_result_rows: z
		.number()
		.int()
		.positive()
		.default(100_000)
		.meta(
			meta({
				label: 'Max result rows',
				description: 'Reject (rather than truncate) a locked-instance result with more rows than this.',
				category: 'context',
				cliOnly: true
			})
		),

	memory_limit: z
		.string()
		.min(1)
		.optional()
		.meta(
			meta({
				label: 'Memory limit',
				description: "DuckDB memory_limit, e.g. '4GB'. Set before setup_sql runs.",
				category: 'context',
				cliOnly: true
			})
		),

	threads: z
		.number()
		.int()
		.positive()
		.optional()
		.meta(
			meta({
				label: 'Threads',
				description: 'DuckDB worker thread count. Set before setup_sql runs.',
				category: 'context',
				cliOnly: true
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
