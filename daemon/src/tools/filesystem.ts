import fs from 'node:fs/promises';
import path from 'node:path';
import {safePath} from '../security/workspace.js';

export async function fsTool(root: string, name: string, a: any) {
  const p = safePath(root, a.path || '.');

  if (name === 'read_file') {
    return {path: a.path, content: await fs.readFile(p, 'utf8')};
  }

  if (name === 'list_directory') {
    return {
      entries: (await fs.readdir(p, {withFileTypes: true})).map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file'
      }))
    };
  }

  if (name === 'write_file') {
    let before = '';
    try {
      before = await fs.readFile(p, 'utf8');
    } catch {}

    const after = String(a.content ?? '');
    await fs.mkdir(path.dirname(p), {recursive: true});
    await fs.writeFile(p, after, 'utf8');
    return {path: a.path, before, after};
  }

  if (name === 'edit_file') {
    const oldText = a.old_text ?? a.old_content ?? a.oldText;
    const newText = a.new_text ?? a.new_content ?? a.newText;
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      throw new Error('edit_file requires old_text and new_text');
    }

    const before = await fs.readFile(p, 'utf8');
    if (!before.includes(oldText)) throw new Error('old_text not found');
    const after = before.replace(oldText, newText);
    await fs.writeFile(p, after, 'utf8');
    return {path: a.path, before, after};
  }

  if (name === 'delete_file') {
    const stat = await fs.lstat(p);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error('delete_file only removes files, not directories');
    }

    const before = stat.isFile() ? await fs.readFile(p, 'utf8') : undefined;
    await fs.unlink(p);
    return {path: a.path, deleted: true, before};
  }

  throw new Error('Unknown filesystem tool');
}
