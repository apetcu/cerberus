export type ThreadStatus = 'provisioning' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface ThreadRecord {
  threadKey: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  status: ThreadStatus;
  runtime: 'docker' | 'k8s';
  containerId: string | null;
  containerName: string | null;
  workspacePath: string;
  failureCount: number;
  createdAt: Date;
  lastActivityAt: Date;
  updatedAt: Date;
}
