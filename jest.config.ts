import type { Config } from "jest";

const config: Config = {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript" },
          target: "es2020",
        },
        module: { type: "commonjs" },
      },
    ],
  },
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  collectCoverageFrom: ["src/**/*.ts", "!src/__tests__/**"],
  moduleNameMapper: {
    "^digest-fetch$": "<rootDir>/src/__mocks__/digest-fetch.ts",
  },
  reporters: [
    "default",
    [
      "jest-html-reporter",
      {
        pageTitle: "SentryBridge Test Report",
        outputPath: "reports/test-report.html",
        includeFailureMsg: true,
        includeConsoleLog: true,
      },
    ],
    [
      "jest-junit",
      {
        outputDirectory: "reports",
        outputName: "junit.xml",
      },
    ],
  ],
};

export default config;
