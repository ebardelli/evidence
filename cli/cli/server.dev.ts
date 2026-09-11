/**
 * Dev-mode entry for `evidence dev`.
 *
 * Runs the same Studio health check the binary path runs, then spawns
 * `vite dev` with the cli package as its cwd (so vite finds its config),
 * forwarding the user's project directory via EVIDENCE_PROJECT_CWD.
 *
 * Used when running from source (detected via `process.execPath`) — see
 * the `dev` case in `index.ts` and `pnpm evd dev`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureStudioServerOrExit, spawnForegroundChild } from './server.shared.ts';

export interface DevServerOptions {
	port: number;
	open: boolean;
}

export async function startDevServer(options: DevServerOptions): Promise<void> {
	const { port, open } = options;

	await ensureStudioServerOrExit();

	const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

	// `run dev` rather than `exec vite dev`: the sandbox iframe runtimes are build
	// output that vite dev serves from static/ but never produces, and the `dev`
	// script chains that build. Without it every {% html %} / {% custom_echart %}
	// block renders blank in source-dev mode.
	const viteArgs = ['run', 'dev', '--port', String(port)];
	if (open) viteArgs.push('--open');

	const projectCwd = process.env.EVIDENCE_PROJECT_CWD ?? process.cwd();

	console.log(`  Starting vite dev (project: ${projectCwd})\n`);

	let code: number;
	try {
		code = await spawnForegroundChild('pnpm', viteArgs, {
			cwd: cliRoot,
			env: {
				...process.env,
				EVIDENCE_PROJECT_CWD: projectCwd
			}
		});
	} catch (err) {
		const errCode = (err as NodeJS.ErrnoException).code;
		if (errCode === 'ENOENT') {
			console.error('  ✗ pnpm not found — ensure pnpm is installed and in your PATH.');
		} else {
			console.error(`  ✗ Failed to start vite dev: ${(err as Error).message}`);
		}
		process.exit(1);
	}
	process.exit(code);
}
