import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ConversationEntry {
  id: string;
  role: 'user' | 'agent';
  text: string;
  ts: string; // ISO-8601
}

/** Durable actor memory: conversation.json in the thread workspace, written atomically. */
export class WorkspaceStore {
  constructor(private readonly root: string) {}

  private file(): string {
    return join(this.root, 'conversation.json');
  }

  async load(): Promise<ConversationEntry[]> {
    try {
      return JSON.parse(await readFile(this.file(), 'utf8')) as ConversationEntry[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async append(entry: ConversationEntry): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const entries = await this.load();
    entries.push(entry);
    const tmp = `${this.file()}.tmp`;
    await writeFile(tmp, JSON.stringify(entries, null, 2));
    await rename(tmp, this.file());
  }
}
