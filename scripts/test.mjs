import { build } from 'esbuild';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const temp = await mkdtemp(join(tmpdir(), 'book-tests-'));
try {
	const tests = (await readdir('tests')).filter(name => name.endsWith('.test.ts'));
	await build({ entryPoints: tests.map(name => resolve('tests', name)), outdir: temp, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', alias: { obsidian: resolve('tests/obsidian-mock.ts') } });
	const result = spawnSync(process.execPath, ['--test', ...tests.map(name => join(temp, name.replace(/\.ts$/, '.cjs')))], { stdio: 'inherit' });
	process.exitCode = result.status ?? 1;
} finally { await rm(temp, { recursive: true, force: true }); }
