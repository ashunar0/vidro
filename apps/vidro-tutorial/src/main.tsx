import { boot } from "@vidro/router/client";

boot(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
