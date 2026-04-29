import { mount } from "@vidro/core";
import App from "./App";
import "./styles.css";

const root = document.getElementById("app")!;

mount(() => <App />, root);
