import { mount } from "@vidro/core";
import App from "./App";

const root = document.getElementById("app")!;

mount(() => <App />, root);
