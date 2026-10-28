import { describe, expect, it } from "vitest";
import {
  REDACTED,
  Redactor,
  isSensitiveKey,
  redactText,
} from "../src/redact.js";

describe("structured redaction", () => {
  it("redacts every value of a Secret's data, stringData and last-applied annotation", () => {
    const redactor = new Redactor();
    const out = redactor.deep({
      kind: "Secret",
      metadata: {
        name: "db",
        annotations: {
          "kubectl.kubernetes.io/last-applied-configuration":
            '{"data":{"password":"x"}}',
          team: "a",
        },
      },
      data: { password: "aHVudGVy", username: "dXNlcg==" },
      stringData: { url: "postgres://x" },
    });
    expect(out).toEqual({
      kind: "Secret",
      metadata: {
        name: "db",
        annotations: {
          "kubectl.kubernetes.io/last-applied-configuration": REDACTED,
          team: "a",
        },
      },
      data: { password: REDACTED, username: REDACTED },
      stringData: { url: REDACTED },
    });
    expect(redactor.count).toBe(4);
  });

  it("redacts sensitive keys and name/value pairs but keeps references to secrets", () => {
    const redactor = new Redactor();
    const out = redactor.deep({
      apiToken: "abc",
      password: 1234,
      env: [
        { name: "DB_PASSWORD", value: "hunter2" },
        { name: "LOG_LEVEL", value: "info" },
      ],
      tls: { secretName: "web-tls" },
      existingSecret: "creds",
      nested: { clientSecret: "s", enabled: true },
      emptyToken: "",
    });
    expect(out).toEqual({
      apiToken: REDACTED,
      password: REDACTED,
      env: [
        { name: "DB_PASSWORD", value: REDACTED },
        { name: "LOG_LEVEL", value: "info" },
      ],
      tls: { secretName: "web-tls" },
      existingSecret: "creds",
      nested: { clientSecret: REDACTED, enabled: true },
      emptyToken: "",
    });
    expect(redactor.count).toBe(4);
  });

  it("does not mutate its input", () => {
    const input = { token: "t" };
    new Redactor().deep(input);
    expect(input.token).toBe("t");
  });

  it("classifies keys", () => {
    for (const key of [
      "password",
      "db.password",
      "API_KEY",
      "privateKey",
      "tls.key",
      "bearerToken",
      "auth",
      "dsn",
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of [
      "secretName",
      "existingSecret",
      "author",
      "image",
      "authority",
      "tokenURL",
      "replicas",
    ]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe("text redaction", () => {
  it("redacts key=value, key: value, bearer tokens, JWTs and URL passwords", () => {
    const input = [
      "connecting with password=hunter2 user=bob",
      'config {"apiToken": "abc123"}',
      "Authorization: Bearer abcdefghijklmnop",
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2ln",
      "fetch https://deploy:s3cr3t@git.example.com/repo.git",
      "secretName: keep-me",
    ].join("\n");
    const { text, count } = redactText(input);
    expect(text).toBe(
      [
        `connecting with password=${REDACTED} user=bob`,
        `config {"apiToken": "${REDACTED}"}`,
        `Authorization: Bearer ${REDACTED}`,
        `token ${REDACTED}`,
        `fetch https://deploy:${REDACTED}@git.example.com/repo.git`,
        "secretName: keep-me",
      ].join("\n"),
    );
    expect(count).toBe(5);
  });

  it("redacts the value line after a sensitive env var name, including in diffs", () => {
    const { text, count } = redactText(
      ">  - name: DB_PASSWORD\n>    value: hunter2\n>  - name: MODE\n>    value: fast",
    );
    expect(text).toBe(
      `>  - name: DB_PASSWORD\n>    value: ${REDACTED}\n>  - name: MODE\n>    value: fast`,
    );
    expect(count).toBe(1);
  });

  it("never treats one line's value as the next line's key", () => {
    const { text } = redactText(
      "value: my-secret-thing\n===== apps/Deployment ns/x ======",
    );
    expect(text.split("\n")[1]).toBe("===== apps/Deployment ns/x ======");
  });
});
