// @vidro/core の公開エントリ。
// primitive の生成は factory (signal / computed / ref / effect) に統一。class 本体は
// internal、型としての Signal<T> 等は `export type` で引き続き使える (型注釈目的)。
export { signal, isSignal } from "./signal";
export type { Signal } from "./signal";
export { signalify, store } from "./store";
export type { Store } from "./store";
export { effect } from "./effect";
export type { Effect } from "./effect";
export { computed } from "./computed";
export type { Computed } from "./computed";
export { ref } from "./ref";
export type { Ref } from "./ref";
export { untrack } from "./observer";
export { batch } from "./batch";
export { onCleanup } from "./owner";
export { onMount } from "./mount-queue";
export { h, Fragment, mount, _reactive, _$text, _$dynamicChild, _$marker } from "./jsx";
export { __VidroIsland, __VidroServerOnlySection } from "./island";
export { Show } from "./show";
export { Switch, Match } from "./switch";
export { For } from "./for";
export { ErrorBoundary } from "./error-boundary";
export { setRenderer, getRenderer } from "./renderer";
export type { Renderer } from "./renderer";
export { hydrate, hydrateRange } from "./hydrate";
export { resource } from "./resource";
export type { Resource } from "./resource";
export { Suspense } from "./suspense";
export { readVidroData } from "./bootstrap";
export { readReactiveSource } from "./reactive-source";
export type { ReactiveSource } from "./reactive-source";
// ADR 0065 で作った per-render scope helper (= raw AsyncLocalStorage + browser fallback)。
// 他 package (例: @vidro/router の getRequestEnv) でも request scope を立てる用途で
// 使えるよう export。runtime 形は scope-context.ts に閉じてる。
export { createScope } from "./scope-context";
export type { Scope } from "./scope-context";
