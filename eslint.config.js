import packageJson from "eslint-plugin-package-json";
import * as jsoncParser from "jsonc-eslint-parser";

export default [
  {
    files: ["package.json"],
    languageOptions: {
      parser: jsoncParser,
    },
    plugins: {
      "package-json": packageJson,
    },
    rules: {
      // Dependency upgrades are deliberate, reviewed changes; ranges must not move them implicitly.
      "package-json/restrict-dependency-ranges": ["error", { rangeType: "pin" }],
    },
  },
];
