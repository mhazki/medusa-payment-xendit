/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        // The package builds with `module: Node16`, but Jest runs on CommonJS.
        // Transpile each file independently (no type-resolution of `exports`
        // subpaths like `@medusajs/framework/utils`, which Jest resolves at
        // runtime) and emit requireable CommonJS.
        tsconfig: {
          module: "commonjs",
          isolatedModules: true,
        },
      },
    ],
  },
}
