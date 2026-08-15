import {spawn} from 'node:child_process';
import {safePath} from '../security/workspace.js';

const blocked = /\b(sudo|su|shutdown|reboot|mkfs|fdisk|mount|umount)\b|rm\s+-rf\s+(\/|~)/i;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 200000;

function appendOutput(current: string, data: unknown) {
  return (current + String(data)).slice(-MAX_OUTPUT_CHARS);
}

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
    const child = spawn(command, {cwd, shell: true, env: process.env});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', data => {
      stdout = appendOutput(stdout, data);
    });
    child.stderr.on('data', data => {
      stderr = appendOutput(stderr, data);
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt
      });
    });
  });
}
