/**
 * Helpers shared between the production server (server.ts) and the
 * dev-mode server (server.dev.ts).
 */

import { exec, spawn } from 'child_process';
import type { SpawnOptions } from 'child_process';

const STUDIO_HOST = process.env.PUBLIC_STUDIO_HOST || 'https://evidence.studio';

export async function checkStudioServer(): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 3000);

		const response = await fetch(`${STUDIO_HOST}/health`, {
			method: 'GET',
			signal: controller.signal
		});

		clearTimeout(timeoutId);
		return response.ok;
	} catch {
		return false;
	}
}

export async function ensureStudioServerOrExit(): Promise<void> {
	const studioRunning = await checkStudioServer();

	if (!studioRunning) {
		console.error(`  ✗ Evidence Studio server is not running at ${STUDIO_HOST}`);
		console.error('');
		console.error('    To start the Studio dev server:');
		console.error('      cd studio && pnpm run dev');
		console.error('');
		console.error('    Or set PUBLIC_STUDIO_HOST if running elsewhere:');
		console.error('      PUBLIC_STUDIO_HOST=https://your-studio.com evidence dev');
		console.error('');
		process.exit(1);
	}
}

// If a signaled child hasn't exited within this long, it's wedged (e.g. a
// native addon's background thread pool outliving its own graceful shutdown)
// — escalate rather than let it block this process from closing forever.
const FORCE_KILL_GRACE_MS = 5000;

/**
 * Spawn `command` in the foreground and wait for it to exit, forwarding
 * SIGINT/SIGTERM from this process to the child so a long-running child
 * (a dev server, a re-exec'd copy of this same process) gets a chance to
 * shut down gracefully instead of being orphaned when this process dies.
 *
 * Using `spawn` (async) rather than `spawnSync` matters here: this process
 * needs its own signal handlers registered *before* the child starts, so a
 * Ctrl+C during the child's lifetime runs `forwardSignal` instead of falling
 * through to the OS's default "terminate immediately" disposition, which
 * would exit this process out from under a still-running child.
 */
export function spawnForegroundChild(
	command: string,
	args: string[],
	options: SpawnOptions = {}
): Promise<number> {
	const child = spawn(command, args, { ...options, stdio: 'inherit' });
	let exited = false;
	let forceKillTimer: NodeJS.Timeout | null = null;

	const forwardSignal = (sig: NodeJS.Signals) => () => {
		if (exited) return;
		child.kill(sig);
		forceKillTimer = setTimeout(() => {
			if (!exited) child.kill('SIGKILL');
		}, FORCE_KILL_GRACE_MS).unref();
	};
	const onSigint = forwardSignal('SIGINT');
	const onSigterm = forwardSignal('SIGTERM');
	process.on('SIGINT', onSigint);
	process.on('SIGTERM', onSigterm);

	return new Promise<number>((resolve, reject) => {
		const cleanup = () => {
			exited = true;
			process.off('SIGINT', onSigint);
			process.off('SIGTERM', onSigterm);
			if (forceKillTimer) clearTimeout(forceKillTimer);
		};
		child.on('error', (err) => {
			cleanup();
			reject(err);
		});
		child.on('exit', (code) => {
			cleanup();
			resolve(code ?? 0);
		});
	});
}

export function openBrowser(url: string): void {
	const platform = process.platform;

	let command: string;
	if (platform === 'darwin') {
		command = `open "${url}"`;
	} else if (platform === 'win32') {
		command = `start "${url}"`;
	} else {
		command = `xdg-open "${url}"`;
	}

	exec(command, () => {
		// Silently fail if browser can't open
	});
}
