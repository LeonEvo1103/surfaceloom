import path from "node:path";

export function defineRepositoryChecks(
  hostPlatform,
  { nodeExecPath, npmExecPath },
  { productChecks = [] } = {},
) {
  if (hostPlatform !== "darwin" && hostPlatform !== "win32") {
    throw new Error("Repository reports are supported on macOS and Windows hosts.");
  }
  const platformPath = hostPlatform === "win32" ? path.win32 : path.posix;
  if (!platformPath.isAbsolute(nodeExecPath ?? "")) {
    throw new Error("The Node executable path must be absolute.");
  }
  if (!platformPath.isAbsolute(npmExecPath ?? "")) {
    throw new Error("repository-report must be launched through npm.");
  }
  validateProductChecks(productChecks);

  const packageCheck = (packageName, spec) => check(
    spec,
    nodeExecPath,
    [npmExecPath, "--prefix", `packages/${packageName}`, "test"],
  );
  const common = [
    packageCheck("core", repositorySpec({
      id: "typescript-core",
      name: "Core 核心契约测试",
      sourceName: "Core contracts",
      intent: "验证跨平台 Driver、Locator、动作门禁、Fixture 和 Trace 的基础语义保持一致，防止底层执行契约回归。",
      criteria: [
        ["contracts-pass", "Core 包的全部契约测试成功完成。"],
      ],
    })),
    packageCheck("component-catalog", repositorySpec({
      id: "typescript-component-catalog",
      name: "组件目录契约测试",
      sourceName: "Component catalog contracts",
      intent: "验证共享组件与 Fixture 的标识、平台能力、依赖引用、查询和机器可读导出保持合法。",
      criteria: [
        ["catalog-valid", "组件和 Fixture manifest 通过全部目录契约校验。"],
      ],
    })),
    packageCheck("reporter", repositorySpec({
      id: "typescript-reporter",
      name: "Reporter 报告器契约测试",
      sourceName: "Reporter contracts",
      intent: "验证报告结构、状态汇总、证据保留、脱敏、安全边界及中文 HTML/Markdown 视图不会回归。",
      criteria: [
        ["report-contracts-pass", "Reporter 包的全部契约测试成功完成。"],
      ],
    })),
    check(repositorySpec({
      id: "repository-contracts",
      name: "仓库与产品边界契约测试",
      sourceName: "Repository and product boundary contracts",
      intent: "验证仓库编排、通用源代码扫描器以及各产品局部安全合同，防止产品规则回流共享包。",
      criteria: [
        ["repository-contracts-pass", "仓库级和产品级静态合同全部成功完成。"],
      ],
    }), nodeExecPath, [
      "scripts/run-repository-contract-tests.mjs",
    ]),
  ];
  const native = hostPlatform === "darwin"
    ? [
        check(repositorySpec({
          id: "architecture",
          name: "架构边界守卫",
          sourceName: "Architecture guard",
          intent: "验证共享层、产品适配层和平台后端之间的依赖方向没有越界，避免产品细节污染通用组件。",
          criteria: [
            ["boundaries-clean", "架构守卫未发现依赖边界违规。"],
          ],
          platforms: ["macos"],
        }), "/bin/bash", [
          "scripts/check-architecture.sh",
        ]),
        check(repositorySpec({
          id: "macos-swift",
          name: "macOS 原生后端契约测试",
          sourceName: "macOS Swift contracts",
          intent: "验证 macOS AX/AppKit 后端的配置、进程所有权、Bundle 和无实时 UI 合约保持稳定。",
          criteria: [
            ["swift-contracts-pass", "macOS Swift 的非实时契约测试成功完成。"],
          ],
          platforms: ["macos"],
        }), "/bin/bash", [
          "scripts/run-swift-tests.sh",
          "--skip-architecture",
        ]),
      ]
    : [
      check(repositorySpec({
        id: "windows-dotnet",
        name: "Windows 原生 Host 契约测试",
        sourceName: "Windows .NET host contracts",
        intent: "验证 Windows UI Automation/Win32 Host 的协议、进程所有权和无实时 UI 契约保持稳定。",
        criteria: [
          ["dotnet-contracts-pass", "Windows .NET Host 的全部契约测试成功完成。"],
        ],
        platforms: ["windows"],
      }), "dotnet", [
        "run",
        "--project",
        "native/windows-host/tests/SurfaceLoom.WindowsHost.ContractTests",
        "-c",
        "Release",
      ]),
    ];

  const checks = [...common, ...native, ...productChecks];
  const duplicateIds = checks
    .map((definition) => definition.spec.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(`Repository check ids must be unique: ${[...new Set(duplicateIds)].join(", ")}`);
  }
  return {
    platform: hostPlatform === "win32" ? "windows" : "macos",
    checks,
  };
}

export function repositorySpec({ id, name, sourceName, intent, criteria, platforms = ["macos", "windows"] }) {
  return {
    id,
    locale: "zh-CN",
    platforms,
    suite: { id: "repository.verification", name: "仓库级验证" },
    name,
    sourceName,
    intent,
    preconditions: [
      { id: "toolchain-ready", text: "当前平台所需工具链与锁文件依赖已经可用。" },
    ],
    acceptanceCriteria: criteria.map(([criterionId, text]) => ({
      id: criterionId,
      text,
    })),
    sideEffect: "writesLocal",
    tags: ["repository", "contract"],
  };
}

export function check(spec, command, args, environment) {
  return {
    spec,
    command,
    args,
    ...(environment === undefined ? {} : { environment }),
  };
}

function validateProductChecks(productChecks) {
  if (!Array.isArray(productChecks)) {
    throw new TypeError("Product repository checks must be an array.");
  }
  for (const [index, definition] of productChecks.entries()) {
    if (typeof definition !== "object" || definition === null
        || typeof definition.spec?.id !== "string" || definition.spec.id.length === 0
        || typeof definition.command !== "string" || definition.command.length === 0
        || !Array.isArray(definition.args)
        || definition.args.some((argument) => typeof argument !== "string")) {
      throw new TypeError(`Product repository check at index ${index} is malformed.`);
    }
  }
}
