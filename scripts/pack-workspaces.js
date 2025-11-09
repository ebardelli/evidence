#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
// globby is ESM-only in recent versions; we'll import it dynamically inside main().
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..');
const packDir = path.join(root, '.pack');
const workspaceFile = path.join(root, 'pnpm-workspace.yaml');

if (!fs.existsSync(packDir)) {
	fs.mkdirSync(packDir, { recursive: true });
}

if (!fs.existsSync(workspaceFile)) {
	console.error('pnpm-workspace.yaml not found in repo root');
	process.exit(1);
}

const doc = yaml.load(fs.readFileSync(workspaceFile, 'utf8'));
const packageGlobs = (doc && doc.packages) || [];

// Filter out negated globs (starting with '!') for now and collect positives
const positiveGlobs = packageGlobs.filter((g) => typeof g === 'string' && !g.startsWith('!'));

async function main() {
	// dynamic import to support ESM-only globby
	let globby;
	try {
		const mod = await import('globby');
		globby = mod && (mod.default || mod.globby || mod);
	} catch (e) {
		// try requiring (older installations)
		try {
			// eslint-disable-next-line global-require
			const _globby = require('globby');
			globby =
				typeof _globby === 'function'
					? _globby
					: _globby && (_globby.globby || _globby.default || _globby);
		} catch (err) {
			console.error('Failed to load globby:', err);
			process.exit(1);
		}
	}

	console.log('Packing workspace packages into', packDir);

	// Expand globs to directories
	const matches = await globby(positiveGlobs, {
		onlyDirectories: true,
		cwd: root,
		gitignore: true
	});

	// Deduplicate and sort
	const packageDirs = Array.from(new Set(matches)).sort();

	if (packageDirs.length === 0) {
		console.log('No workspace packages found');
		return;
	}

	let failures = 0;

	// Allow filtering by package name prefix, default to 'evidence-'
	const PACK_PREFIX = (process.env.PACK_PREFIX || 'evidence-').trim();

	for (const rel of packageDirs) {
		const pkgPath = path.join(root, rel);
		const pkgJson = path.join(pkgPath, 'package.json');
		if (!fs.existsSync(pkgJson)) continue;

		const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
		// sanitize name (fallback to directory name) and decide whether to pack
		const pkgName = (pkg.name || rel || '').replace(/^@/, '').replace(/[\/]/g, '-');
		if (!pkgName.startsWith(PACK_PREFIX)) {
			console.log('\nSkipping', pkg.name || rel, `(does not start with '${PACK_PREFIX}')`);
			continue;
		}

		console.log('\nPacking', pkg.name || rel);

		const res = spawnSync('pnpm', ['pack', '--pack-destination', packDir], {
			cwd: pkgPath,
			stdio: 'inherit'
		});

		if (res.error) {
			console.error('Failed to execute pnpm for', rel, res.error);
			failures++;
			continue;
		}

		if (res.status !== 0) {
			console.error('pnpm pack failed for', rel, 'exit code', res.status);
			failures++;
			continue;
		}
	}

	if (failures > 0) {
		console.error('\nCompleted with', failures, 'failures');
		process.exit(1);
	}

	console.log('\nDone — packed workspace packages are in', packDir);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
