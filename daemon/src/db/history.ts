import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

type Statement = {
  run: (...params: any[]) => unknown;
  all: (...params: any[]) => unknown[];
};

type HistoryDatabase = {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => Statement;
};

async function openDatabase(file: string): Promise<HistoryDatabase> {
  if (typeof (globalThis as {Bun?: unknown}).Bun !== 'undefined') {
    const {Database} = await import('bun:sqlite');
    return new Database(file) as unknown as HistoryDatabase;
  }

  const {default: Database} = await import('better-sqlite3');
  return new Database(file) as unknown as HistoryDatabase;
}

const dir = path.join(os.homedir(), '.deepseek-local');
fs.mkdirSync(dir, {recursive: true});
const db = await openDatabase(path.join(dir, 'history.db'));
db.exec('CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY,ts TEXT,tool TEXT,args TEXT,result TEXT,ok INTEGER);');

export function log(tool: string, args: any, result: any, ok: boolean) {
  db.prepare('INSERT INTO calls(ts,tool,args,result,ok) VALUES(?,?,?,?,?)')
    .run(new Date().toISOString(), tool, JSON.stringify(args), JSON.stringify(result), ok ? 1 : 0);
}

export function history(limit = 50) {
  return db.prepare('SELECT * FROM calls ORDER BY id DESC LIMIT ?').all(limit);
}
