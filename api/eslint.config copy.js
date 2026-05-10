// eslint.config.js  (or .eslintrc.cjs)
export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      sourceType: "module"
    },
    plugins: {
      import: await import("eslint-plugin-import")
    },
    rules: {
      // 🚨 Enforce explicit .js extensions
      "import/extensions": [
        "error",
        "ignorePackages",
        {
          js: "always",
          mjs: "always"
        }
      ],

      // Prevent unresolved imports (ignore package subpath exports that resolvers may not follow)
      "import/no-unresolved": ["error", { ignore: ["^pgvector/"] }]
    }
  }
];
