import type {Config} from "jest";

const config: Config = {
  testEnvironment: "node",
  projects: [
    {
      displayName: "js",
      testEnvironment: "node",
      testMatch: ["**/tests/**/*.test.js"],
    },
    {
      displayName: "ts",
      testEnvironment: "node",
      testMatch: ["**/tests/**/*.test.ts"],
      transform: {
        "^.+\\.tsx?$": ["ts-jest", {tsconfig: {allowJs: true}}],
      },
      moduleNameMapper: {
        "^@types/(.*)$": "<rootDir>/src/types/$1",
        "^@services/(.*)$": "<rootDir>/src/services/$1",
        "^@utils/(.*)$": "<rootDir>/src/utils/$1",
      },
    },
  ],
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!**/node_modules/**",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov", "html"],
  verbose: true,
};

export default config;
