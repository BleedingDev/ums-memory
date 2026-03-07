declare module "node:util" {
  interface TextEncoderEncodeIntoResult {
    readonly read: number;
    readonly written: number;
  }
}

declare global {
  type ConnectionOptions = import("node:tls").ConnectionOptions;
  type KeyObject = import("node:crypto").KeyObject;
  type TLSSocket = import("node:tls").TLSSocket;
}

export {};
