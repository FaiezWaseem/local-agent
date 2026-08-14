import {shell} from './tools/shell.js';
import {log} from './db/history.js';

type ShellJob = {
  id: string;
  tool: 'run_command';
  args: Record<string, unknown>;
  state: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
};

const jobs = new Map<string, ShellJob>();
const MAX_RETAINED_JOBS = 500;

function publicJob(job: ShellJob) {
  const base = {
    tool_call_id: job.id,
    tool: job.tool,
    state: job.state,
    pending: job.state === 'running',
    started_at: job.startedAt,
    completed_at: job.completedAt
  };

  if (job.state === 'failed') {
    return {...base, success: false, error: job.error};
  }
  return {...base, success: true, result: job.result};
}

function trimFinishedJobs() {
  if (jobs.size < MAX_RETAINED_JOBS) return;
  for (const [id, job] of jobs) {
    if (job.state !== 'running') jobs.delete(id);
    if (jobs.size < MAX_RETAINED_JOBS) return;
  }
}

export function startShellJob(workspace: string, args: Record<string, unknown>, id: string) {
  const existing = jobs.get(id);
  if (existing) return publicJob(existing);

  trimFinishedJobs();
  const job: ShellJob = {
    id,
    tool: 'run_command',
    args,
    state: 'running',
    startedAt: new Date().toISOString()
  };
  jobs.set(id, job);

  void shell(workspace, args).then(result => {
    job.state = 'completed';
    job.completedAt = new Date().toISOString();
    job.result = result;
    log(id, job.tool, args, result, true);
  }).catch(error => {
    job.state = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = (error as Error).message;
    log(id, job.tool, args, {error: job.error}, false);
  });

  return publicJob(job);
}

export function getShellJob(id: string) {
  const job = jobs.get(id);
  return job ? publicJob(job) : undefined;
}
