import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceStore, type ConversationEntry } from '../src/workspace.js';

describe('WorkspaceStore', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'cerberus-ws-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const entry = (id: string, role: 'user' | 'agent'): ConversationEntry => ({
    id, role, text: `msg-${id}`, ts: new Date().toISOString(),
  });

  it('returns [] when conversation.json does not exist', async () => {
    expect(await new WorkspaceStore(root).load()).toEqual([]);
  });

  it('appends and reloads entries in order', async () => {
    const store = new WorkspaceStore(root);
    await store.append(entry('1', 'user'));
    await store.append(entry('2', 'agent'));
    const loaded = await store.load();
    expect(loaded.map((e) => e.id)).toEqual(['1', '2']);
  });

  it('creates missing root directory on append', async () => {
    const store = new WorkspaceStore(join(root, 'nested'));
    await store.append(entry('1', 'user'));
    expect((await store.load()).length).toBe(1);
  });
});
