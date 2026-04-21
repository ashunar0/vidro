import "./style.css";
import { App } from "./App";

// エントリポイント: #app を見つけて App をマウントする。
const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("#app not found");
App(root);
