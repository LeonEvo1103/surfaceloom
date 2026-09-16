import assert from "node:assert/strict";
import test from "node:test";

import { redactReportText, redactTraceValue } from "../src/index.js";

test("redacts credentials, user-home segments, and dynamic trace keys", () => {
  assert.equal(
    redactReportText("Bearer abc.def token=private; /Users/alice/a /home/runner/b C:\\Users\\bob\\c"),
    "Bearer [REDACTED] token=[REDACTED]; $USER_HOME/a $USER_HOME/b %USERPROFILE%\\c",
  );
  assert.deepEqual(redactTraceValue({
    "field-3": "original",
    "token=trace-secret": "value",
    "/Users/alice/path": "value",
    "/Users/bob/path": "collision",
  }), {
    "field-3": "original",
    "token=[REDACTED]": "[REDACTED]",
    "$USER_HOME/path": "value",
    "field-3-1": "collision",
  });
  assert.deepEqual(redactTraceValue({
    passwd: "two words",
    private_key: "private material",
    AWS_ACCESS_KEY_ID: "not-even-a-shaped-key",
    token_value: "opaque token",
    secretValue: "opaque secret",
    passwordHash: "opaque hash",
    tokenCount: 2,
    secretName: "fixture",
    safe: "visible",
  }), {
    passwd: "[REDACTED]",
    private_key: "[REDACTED]",
    AWS_ACCESS_KEY_ID: "[REDACTED]",
    token_value: "[REDACTED]",
    secretValue: "[REDACTED]",
    passwordHash: "[REDACTED]",
    tokenCount: 2,
    secretName: "fixture",
    safe: "visible",
  });
});

test("redacts complete JSON and quoted assignment values", () => {
  const output = redactReportText(
    `request={"token":"private-value","ok":true} `
      + `password='two words'; api_key = "abc def" `
      + `payload={"password":"two words\\\"tail","keep":"visible"} `
      + `wrapped="token=inside-private"`,
  );

  assert.doesNotMatch(output, /private-value|two words|abc def|tail|inside-private/);
  assert.match(output, /"token":"\[REDACTED\]"/);
  assert.match(output, /"ok":true/);
  assert.match(output, /"keep":"visible"/);
  assert.equal(redactReportText(output), output);
});

test("redacts camel-case credential fields and complete sensitive headers", () => {
  const output = redactReportText(
    `request={"accessToken":"opaque-one","refreshToken":"opaque-two",`
      + `"clientSecret":"opaque-three","clientApiKey":"opaque-four",`
      + `"clientPrivateKey":"opaque-five","oauth_accessToken":"opaque-six","ok":true}\n`
      + `Authorization: SharedKey acct:opaque-signature\n`
      + `Cookie: first=opaque-cookie-one; second=opaque-cookie-two\nkeep=visible`,
  );

  assert.doesNotMatch(output, /opaque-(?:one|two|three|four|five|six|signature)/);
  assert.doesNotMatch(output, /opaque-cookie-one|opaque-cookie-two/);
  assert.match(output, /Authorization: \[REDACTED\]/);
  assert.match(output, /Cookie: \[REDACTED\]/);
  assert.match(output, /"ok":true|keep=visible/);
  assert.equal(redactReportText(output), output);
});

test("redacts unterminated quoted secrets without masking safe lookalike keys", () => {
  const output = redactReportText(`password="one two\nclientSecret='three four`);
  assert.doesNotMatch(output, /one two|three four/);
  assert.equal(redactReportText(output), output);

  const safe = `tokenCount=3 passwordPolicy=strict publicKey=demo `
    + `secretName=fixture cookieEnabled=true`;
  assert.equal(redactReportText(safe), safe);
  assert.equal(redactReportText("token=\nkeep=visible"), "token=\nkeep=visible");
});

test("rescans safe wrapper values for nested sensitive assignments", () => {
  const inputs = [
    "url=https://example.test/path?token=query-private&ok=true",
    "wrapper=token=wrapper-private keep=visible",
    `safe="token=quoted-private"`,
  ];
  for (const input of inputs) {
    const output = redactReportText(input);
    assert.doesNotMatch(output, /query-private|wrapper-private|quoted-private/);
    assert.equal(redactReportText(output), output);
  }
});

test("redacts structured sensitive values and handles large wrapper input", () => {
  const structured = redactReportText(
    `token=[opaque-token] password={opaque-password} `
      + `payload={"credentials":{"blob":"opaque-secret"},"safe":true} `
      + `clientSecret=(opaque parenthesized secret)`,
  );
  assert.doesNotMatch(structured, /opaque-token|opaque-password|opaque-secret|parenthesized/);
  assert.match(structured, /"safe":true/);
  assert.equal(redactReportText(structured), structured);

  const large = `safe=${"x=".repeat(32_000)} token=tail-private keep=visible`;
  const redacted = redactReportText(large);
  assert.doesNotMatch(redacted, /tail-private/);
  assert.match(redacted, /keep=visible$/);
});

test("does not trust a redaction marker with a secret tail", () => {
  const inputs = [
    "token=[REDACTED]opaque-secret",
    "password=[REDACTED]-actual-password",
    "accessToken=[REDACTED] real-tail",
  ];
  for (const input of inputs) {
    const output = redactReportText(input);
    assert.doesNotMatch(output, /opaque-secret|actual-password|real-tail/);
    assert.equal(redactReportText(output), output);
  }
  assert.equal(
    redactReportText(`safe="token=[REDACTED]" keep=visible`),
    `safe="token=[REDACTED]" keep=visible`,
  );
});

test("redacts high-confidence provider secrets without masking public lookalikes", () => {
  const secrets = [
    `ghp_${"a".repeat(36)}`,
    `ghs_12345_${"j".repeat(20)}.${"k".repeat(20)}`,
    `github_pat_${"b".repeat(30)}`,
    `sk_live_${"c".repeat(24)}`,
    `rk_live_${"d".repeat(24)}`,
    `whsec_${"e".repeat(24)}`,
    `AKIA${"F".repeat(16)}`,
    `ASIA${"G".repeat(16)}`,
    `sk-proj-${"h".repeat(24)}`,
  ];
  const output = redactReportText(secrets.join(" "));

  for (const secret of secrets) assert.doesNotMatch(output, new RegExp(secret));
  const safe = `pk_live_${"p".repeat(24)} ghp_demo sk-short ${"Q".repeat(20)} AWS_REGION=us-east-1`;
  assert.equal(redactReportText(safe), safe);
});

test("redacts named AWS credentials while retaining ordinary AWS settings", () => {
  const output = redactReportText(
    `AWS_SECRET_ACCESS_KEY="two words" AWS_SESSION_TOKEN='session value' AWS_REGION=us-east-1 `
      + `sdk={"accessKeyId":"AKID-NOT-SHAPED","secretAccessKey":"opaque-aws-secret",`
      + `"sessionToken":"opaque-session"}`,
  );

  assert.doesNotMatch(
    output,
    /two words|session value|AKID-NOT-SHAPED|opaque-aws-secret|opaque-session/,
  );
  assert.match(output, /AWS_REGION=us-east-1/);
});
