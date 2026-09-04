import { z } from 'zod';

/**
 * The `auth:` frontmatter block — restricts a page to specific viewers,
 * checked against the reverse-proxy identity in serve mode (see
 * `cli/src/lib/server/proxy-auth.server.ts`). Self-host only; a no-op outside
 * `evidence serve` or when the proxy email header isn't configured.
 *
 * `users` and `query` are both optional and additive: a viewer is allowed if
 * their email appears in either list. `query` is a SQL string run server-side
 * against `connection.yaml`; its first result column is read as the allowed
 * emails.
 */
export const authSchema = z.object({
	users: z
		.array(z.string())
		.optional()
		.catch(undefined)
		.describe('Emails allowed to view this page.'),
	query: z
		.string()
		.optional()
		.catch(undefined)
		.describe(
			"SQL query run server-side against connection.yaml; its first result column is read as allowed emails."
		)
});

export type AuthConfig = z.infer<typeof authSchema>;
