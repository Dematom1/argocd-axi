import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,mjs}"],
    testTimeout: 20000,
  },
});
