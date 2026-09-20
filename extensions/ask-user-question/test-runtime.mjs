// Test against the installed Pi SDK, as the extension loader does; no second Pi install.
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// npm --prefix sets this for scripts; it is not the global installation prefix.
const env = { ...process.env };
delete env.npm_config_prefix;
delete env.NPM_CONFIG_PREFIX;
const core = process.env.PI_TEST_CORE_DIR ?? join(execFileSync("npm", ["root", "-g"], { encoding: "utf8", env }).trim(), "@earendil-works/pi-coding-agent");
const parentURL = pathToFileURL(join(core, "package.json")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") return { url: pathToFileURL(join(core, "dist/index.js")).href, shortCircuit: true };
    if (specifier.startsWith("@earendil-works/pi-") || specifier === "typebox" || specifier.startsWith("typebox/")) {
      return nextResolve(specifier, { ...context, parentURL });
    }
    return nextResolve(specifier, context);
  },
});
