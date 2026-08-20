// このスパイクでは @webgpu/types を追加インストールしない方針のため、
// TypeScript 5.9 系の lib.dom.d.ts に無い WebGPU の最小限の面と
// navigator.deviceMemory (非標準の Device Memory API) だけをここで宣言する。
// spike/ の外の型チェック (src/ 配下) には一切影響しない。
export {};

declare global {
  interface GPUAdapterInfo {
    readonly vendor?: string;
    readonly architecture?: string;
    readonly device?: string;
    readonly description?: string;
  }

  interface GPUAdapter {
    readonly info?: GPUAdapterInfo;
  }

  interface GPU {
    requestAdapter(options?: Record<string, unknown>): Promise<GPUAdapter | null>;
  }

  interface Navigator {
    readonly gpu?: GPU;
    // Device Memory API。非標準・実験的で lib.dom.d.ts には含まれない。対応ブラウザは限定的。
    readonly deviceMemory?: number;
  }
}
