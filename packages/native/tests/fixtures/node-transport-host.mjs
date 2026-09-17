import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { closeSync } from "node:fs";

const mode = process.argv[2] ?? "echo";
const argumentsAfterMode = process.argv.slice(3);

function writeBytes(bytes, bytewise = false) {
  if (!bytewise) {
    process.stdout.write(bytes);
    return;
  }
  let offset = 0;
  const next = () => {
    if (offset === bytes.length) return;
    process.stdout.write(bytes.subarray(offset, offset + 1), () => {
      offset += 1;
      setImmediate(next);
    });
  };
  next();
}

if (mode === "argv") {
  process.stdout.end(`${JSON.stringify(argumentsAfterMode)}\n`);
} else if (mode === "raw" || mode === "bytewise") {
  const bytes = Buffer.from(argumentsAfterMode[0] ?? "", "base64");
  writeBytes(bytes, mode === "bytewise");
  if (mode === "raw") process.stdout.end();
  else setTimeout(() => process.stdout.end(), Math.max(20, bytes.length * 2));
} else if (mode === "stderr-flood") {
  const line = "TOKEN=do-not-retain diagnostic padding padding padding\n";
  for (let index = 0; index < 4_000; index += 1) process.stderr.write(line);
  process.stdout.end("ready\n");
} else if (mode === "stderr-long-split") {
  process.stderr.write(`TOKEN=${"x".repeat(5_000)}`, () => {
    process.stderr.end("sensitive-suffix\n");
    process.stdout.end("ready\n");
  });
} else if (mode === "stderr-unicode") {
  process.stderr.write("猫猫");
  process.stdout.end("ready\n");
} else if (mode === "both") {
  process.stderr.write("password=hunter2\n");
  process.stdout.end("one\ntwo\n");
} else if (mode === "no-read") {
  setInterval(() => {}, 1_000);
} else if (mode === "crash-on-data") {
  process.stdin.once("data", () => process.exit(23));
} else if (mode === "stdout-close") {
  closeSync(1);
  setInterval(() => {}, 1_000);
} else if (mode === "buffered-exit") {
  process.stdout.write("first\nsecond-tail", () => process.exit(0));
} else if (mode === "slow-eof") {
  process.stdin.resume();
  process.stdin.once("end", () => setTimeout(() => process.exit(0), 150));
} else if (mode === "inherited-stdio") {
  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 500)"], {
    stdio: ["ignore", process.stdout, process.stderr],
  });
  grandchild.once("spawn", () => process.stdout.write("ready\n", () => {
    setTimeout(() => process.exit(0), 10);
  }));
} else if (mode === "protocol-crash") {
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const request = JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      if (request.call?.name === "host.handshake") {
        process.stdout.write(`${JSON.stringify({ protocol: "surfaceloom.native", version: "1.0",
          type: "response", id: request.id, ok: true, result: { hostInstanceId: "fixture-host",
            platform: "windows", backend: "uia", maxMessageBytes: 1048576, methods: [
              { name: "host.handshake", intent: "observe", scopeKinds: ["bootstrap"] },
              { name: "fixture.mutate", intent: "mutate", scopeKinds: ["host"] },
            ] }, operation: null })}\n`);
      } else process.exit(29);
    }
  });
} else {
  process.stdin.pipe(process.stdout);
}
