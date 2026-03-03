declare module "*runtime-adapter.mjs" {
  export const DEFAULT_RUNTIME_STATE_FILE: string;
  export function executeRuntimeOperation(request: {
    operation: string;
    requestBody?: unknown;
    stateFile?: string | null;
    env?: NodeJS.ProcessEnv;
    reload?: boolean;
  }): Promise<unknown>;
  export function listRuntimeOperations(options?: {
    env?: NodeJS.ProcessEnv;
    reload?: boolean;
  }): Promise<string[]>;
}
