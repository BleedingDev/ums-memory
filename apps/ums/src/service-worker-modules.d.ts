declare module "*service-runtime.mjs" {
  export function startSupervisedApiService(config: {
    host: string;
    port: number;
    stateFile: string;
  }): Promise<{
    service: {
      status: () => { phase: string; lastError?: string };
    };
    host: string;
    port: number;
  }>;
}

declare module "*worker-runtime.mjs" {
  export function startSupervisedWorkerService(config: {
    intervalMs: number;
    stateFile: string;
    restartLimit: number;
    restartDelayMs: number;
  }): Promise<{
    service: {
      status: () => {
        phase: string;
        intervalMs: number;
        stateFile: string | null;
        lastError?: string;
      };
    };
  }>;
}
