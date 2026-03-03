declare module "*runtime-adapter.ts" {
  export const DEFAULT_RUNTIME_STATE_FILE: string;
  export function executeRuntimeOperation(request: {
    operation: string;
    requestBody: unknown;
    stateFile: string;
  }): Promise<unknown>;
  export function listRuntimeOperations(): Promise<string[]>;
}
