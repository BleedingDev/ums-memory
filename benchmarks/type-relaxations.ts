declare module "node:sqlite" {
  interface DatabaseSyncOptions {
    readBigInts?: boolean;
  }

  interface StatementSync {
    get(...params: any[]): any;
    all(...params: any[]): any[];
    run(...params: any[]): any;
  }
}

export {};
