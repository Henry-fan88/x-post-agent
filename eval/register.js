/**
 * Extensionless imports, for Node.
 *
 * The Worker source is bundled by Wrangler, which resolves `./chars` to
 * `chars.ts` without being told. Node's ESM resolver does not, so the eval --
 * which imports the same modules directly, on purpose, so it tests the shipped
 * code rather than a copy of it -- needs this hook to agree with the bundler.
 *
 * Used via `node --import ./eval/register.js`.
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const CANDIDATES = [".ts", ".js", "/index.ts", "/index.js"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$|\.json$/i.test(specifier)) {
      const base = new URL(specifier, context.parentURL).href;
      for (const suffix of CANDIDATES) {
        const candidate = `${base}${suffix}`;
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
