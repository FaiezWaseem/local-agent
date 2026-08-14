import {spawn} from 'node:child_process';
import {safePath} from '../security/workspace.js';

const blocked = /\b(sudo|su|shutdown|reboot|mkfs|fdisk|mount|umount)\b|rm\s+-rf\s+(\/|~)/i;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function shell(root: string, args: any) {
  return new Promise((resolve, reject) => {
    const command = String(args.command || '');
    if (!command.trim()) return reject(new Error('run_command requires command'));
    if (blocked.test(command)) return reject(new Error('Blocked high-risk command'));

    const cwd = safePath(root, args.cwd || '.');
    const requestedTimeout = Number(args.timeout_ms ?? args.timeout ?? DEFAULT_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(requestedTimeout)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, requestedTimeout))
      : DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    const process = spawn(command, {cwd, shell: true, env: processEnv()});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      process.kill('SIGTERM');
    }, timeoutMs);

    process.stdout.on('data', data => {
      stdout += data;
    });
    process.stderr.on('data', data => {
      stderr += data;
    });
    process.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    process.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: stdout.slice(-200000),
        stderr: stderr.slice(-200000),
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt
      });
    });
  });
}

function processEnv() {
  return process.env;
}
