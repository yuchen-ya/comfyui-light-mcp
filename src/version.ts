import { readFileSync } from "node:fs";

// src/ and dist/ have the same depth relative to the installed package metadata.
export const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
