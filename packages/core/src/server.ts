// @vidro/core/server — server-only entry。
// client bundle には含めない (document 等が存在する前提のコードは入れない)。

export {
  renderToString,
  renderToStringAsync,
  renderToReadableStream,
  VIDRO_STREAMING_RUNTIME,
  VIDRO_BOOT_TRIGGER,
} from "./render-to-string";
export type { RenderToStringAsyncResult } from "./render-to-string";
export type { BootstrapValue, SerializedError } from "./resource-scope";
