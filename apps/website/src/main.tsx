import "./style.css";
import { mount } from "@vidro/core";
import { App } from "./App";

// エントリポイント: #app を見つけて <App /> をマウントする。
// mount() は thunk を受け取って内部で root Owner を active にしてから JSX を評価する。
const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("#app not found");
mount(() => <App />, root);
