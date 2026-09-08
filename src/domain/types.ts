export type WorkspaceStatus = 'active' | 'retained' | 'trashed';
export type SandboxStatus = 'creating' | 'running' | 'destroying' | 'destroyed' | 'failed';

export interface Workspace {
  readonly id: string;
  readonly ownerId: string;
  readonly root: string;
  readonly status: WorkspaceStatus;
  readonly createdAt: number;
  readonly retainedUntil?: number;
}

export interface Sandbox {
  readonly id: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly runtimeName: string;
  readonly runtimeRoot?: string;
  readonly status: SandboxStatus;
  readonly endpoint?: string;
  readonly authToken?: string;
  readonly error?: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly expiresAt: number;
  readonly destroyedAt?: number;
  readonly memoryBytes?: number;
}

export interface SandboxSummary {
  readonly id: string;
  readonly status: SandboxStatus;
  readonly workspace: Workspace;
  readonly error?: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly expiresAt: number;
  readonly destroyedAt?: number;
  readonly memory: string | null;
}

export interface SandboxCreateResult {
  readonly status: 'created' | 'reused';
  readonly sandbox: SandboxSummary;
}

export interface SandboxPortExposure {
  readonly sandboxId: string;
  readonly sandboxPort: number;
  readonly host: string;
  readonly hostPort: number;
}
