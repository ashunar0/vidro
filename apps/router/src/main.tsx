import { boot } from "@vidro/router/client";
import "./styles.css";

boot(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
