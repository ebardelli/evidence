/**
 * Helpers shared between the production server (server.ts) and the
 * dev-mode server (server.dev.ts).
 */

import { exec, spawn } from 'child_process';
import type { SpawnOptions } from 'child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

const STUDIO_HOST = process.env.PUBLIC_STUDIO_HOST || 'https://evidence.studio';

// A first TLS handshake through a corporate proxy routinely exceeds the old 3s budget.
const STUDIO_PROBE_TIMEOUT_MS = 10_000;

export type StudioProbeResult = { ok: true } | { ok: false; reason: string };

// connection.yaml projects never touch the managed engine, so Studio reachability is irrelevant.
export function hasConnectionYaml(): boolean {
	const cwd = process.env.EVIDENCE_PROJECT_CWD || process.cwd();
	return existsSync(path.join(cwd, 'connection.yaml'));
}

/** One-line summary of where `dev` will send queries, printed under "Ready at". */
export async function describeDevMode(): Promise<string> {
	if (!hasConnectionYaml()) {
		return 'Evidence Warehouse (managed) — run `evidence login` if you have not yet';
	}
	const cwd = process.env.EVIDENCE_PROJECT_CWD || process.cwd();
	let type = 'connection.yaml';
	try {
		// Only `type`: a missing secret must not stop the server from starting.
		const raw = yaml.load(await readFile(path.join(cwd, 'connection.yaml'), 'utf-8'));
		const declared = (raw as { type?: unknown } | null)?.type;
		if (typeof declared === 'string' && declared) type = declared;
	} catch {
		/* malformed YAML is reported at query time */
	}
	return `direct connector (${type}) — no Evidence Studio login required`;
}

export function describeFetchFailure(err: unknown, timeoutMs: number): string {
	if (err instanceof Error) {
		if (err.name === 'AbortError' || err.name === 'TimeoutError') {
			return `timed out after ${Math.round(timeoutMs / 1000)}s`;
		}
		const code =
			(err as NodeJS.ErrnoException).code ?? (err.cause as NodeJS.ErrnoException | undefined)?.code;
		if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS lookup failed';
		// The shipped binary runs on Bun, whose fetch uses its own codes instead of errnos.
		if (code === 'ECONNREFUSED' || code === 'ConnectionRefused') return 'connection refused';
		if (code === 'ECONNRESET' || code === 'ConnectionClosed') return 'connection reset';
		if (typeof code === 'string' && code.includes('CERT')) return `certificate error (${code})`;
		if (err.message) return err.message;
	}
	return 'unknown error';
}

export async function checkStudioServer(): Promise<StudioProbeResult> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), STUDIO_PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(`${STUDIO_HOST}/health`, {
			method: 'GET',
			signal: controller.signal
		});
		if (response.ok) return { ok: true };
		return { ok: false, reason: `HTTP ${response.status}` };
	} catch (err) {
		return { ok: false, reason: describeFetchFailure(err, STUDIO_PROBE_TIMEOUT_MS) };
	} finally {
		clearTimeout(timeoutId);
	}
}

// Never exits: pages render offline, only warehouse queries need Studio.
export async function warnIfStudioUnreachable(): Promise<void> {
	if (hasConnectionYaml()) return;

	const probe = await checkStudioServer();
	if (probe.ok) return;

	console.error(`  ⚠ Could not reach Evidence Studio at ${STUDIO_HOST} (${probe.reason}).`);
	console.error('');
	console.error('    Pages will render, but queries against the Evidence Warehouse will fail');
	console.error('    until the connection is restored.');
	console.error('');
	console.error('    To query your own database instead, add a connection.yaml — no Studio');
	console.error('    connection is needed for direct connectors.');
	console.error('    If you are behind a corporate proxy, set HTTPS_PROXY.');
	console.error('');
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
