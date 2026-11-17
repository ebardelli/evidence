import { z } from 'zod';

/**
 * The `auth:` frontmatter block — per-viewer row security for a page,
 * enforced against the reverse-proxy identity in `evidence serve` (see
 * `cli/src/lib/server/row-security.server.ts`). Self-host only; ignored by
 * `evidence dev`.
 *
 * `rows` maps a table (as written in SQL: `students`, `main.students`) to a
 * SQL predicate over that table's columns. `{{ $user.email }}` in the
 * predicate is replaced with the viewer's email as a quoted SQL literal. The
 * server applies the predicate to every read of that table made from this
 * page, and a viewer for whom every filtered table comes back empty is
 * refused the page. `message` overrides the default denial text.
 *
 * `tables` lists the other tables this page's queries may read. Once any page
 * in the project has `rows`, every page is limited to its own `tables` plus
 * the keys of its own `rows`; a query reading anything else is refused.
 */
export const authSchema = z.object({
	rows: z
		.record(z.string(), z.string())
		.optional()
		.catch(undefined)
		.describe(
			'Row filters keyed by table name. Each value is a SQL predicate applied server-side to every read of that table from this page; `{{ $user.email }}` is the viewer\'s email.'
		),
	tables: z
		.array(z.string())
		.optional()
		.catch(undefined)
		.describe(
			'Tables (as written in SQL) this page\'s queries may read, besides those in `rows`. Once any page uses `auth.rows`, every other table is refused.'
		),
	message: z
		.string()
		.optional()
		.catch(undefined)
		.describe(
			"Custom message shown to viewers denied access to this page. `{email}` is replaced with the viewer's email."
		)
})
	// Kept so the CLI can refuse to serve pages still using the removed
	// `users` / `query` allowlist keys, rather than serving them unrestricted.
	.passthrough();

export type AuthConfig = z.infer<typeof authSchema>;
