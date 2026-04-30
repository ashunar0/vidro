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
export { h, Fragment, mount, _reactive, _$text, _$dynamicChild } from "./jsx";
export { Show } from "./show";
export { Switch, Match } from "./switch";
export { For } from "./for";
export { ErrorBoundary } from "./error-boundary";
export { setRenderer, getRenderer } from "./renderer";
export type { Renderer } from "./renderer";
export { hydrate } from "./hydrate";
export { resource } from "./resource";
export type { Resource } from "./resource";
export { Suspense } from "./suspense";
export { readVidroData } from "./bootstrap";
export { readReactiveSource } from "./reactive-source";
export type { ReactiveSource } from "./reactive-source";
