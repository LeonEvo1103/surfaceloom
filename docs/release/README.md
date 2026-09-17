# Release contract（SL-P4-005）

本目录只冻结候选发布的计划、最终事实和验证边界；它不构建、不签名、不上传、不发布，也不修改当前七个包的 `private`、`file:` 依赖或 lock。发布执行和 registry 验收属于后续任务。

## 两类记录

`ReleasePlan` 使用独立版本 `surfaceloom.release-plan/1`。它从七个真实 `package.json` 生成包快照和无环构建顺序，可以显式保存 `pending` source revision、snapshot digest 和 lock digest。当前 manifest 的 `private: true` 与 `file:` 依赖会成为 readiness blockers，不会被生成器悄悄改写。计划同时声明 host OS、architecture、RID、runtime、deployment、minimum OS、universal slices、预期 artifact/inventory 和签名策略。

`ReleaseManifest` 使用独立版本 `surfaceloom.release-manifest/1`。它只接受已经存在并重新扫描过的最终 bytes；不接受 `pending`、全零 hash、源码/lock hash 冒充 artifact hash、planned signature 或 secret。每个最终 artifact 都包含 byte length、SHA-256、精确递归 inventory、完整 scan receipt 和签名事实。七包的 name/version/dependencies/peerDependencies/optionalDependencies/exports/bin/assets/license 都是发布候选快照的一部分。

兼容矩阵分别固定 npm、native wire、report、trace、component catalog 和 native-host 版本。manifest 与 plan 一起验证时，package version、target architecture/RID/runtime、协议和预期 artifact/inventory 的漂移都会失败。

## 唯一允许的顺序

顺序固定且不可重排：

1. build
2. strip
3. platform sign and staple
4. final package
5. digest
6. SBOM, recursive scan and provenance
7. manifest
8. detached manifest signature

这避免 artifact 签名或封装后的 bytes 又被修改。detached manifest signature 在 manifest bytes 固定以后生成，因此其 secret 和签名 bytes 不写回被签名的 manifest；计划记录签名策略，sidecar/外部验证记录证明 detached signature。artifact 的签名事实只能是 `unsigned`、`unverified` 或 `verified`；`planned` 只属于计划。identity 和 evidence 可以记录，private key、token、password、credential 不得记录。

## 最终字节与递归扫描

`scanArtifact()` 依 magic 而不是扩展名识别 ZIP、gzip/TAR、V7/ustar TAR、PE 和嵌套 TAR，并显式拒绝 RAR4/RAR5、7z、XZ、zstd、bzip2、CAB 等未实现容器。`.app` 在本合同中指最终 ZIP 形式的 distributable bundle，并且必须含唯一顶层 `.app/` inventory；普通 `.app` 目录没有单一最终 byte stream，不能直接声称一个 artifact digest。

扫描器有显式 archive bytes、entry count、single-entry size、total expanded size、compression ratio 和 nesting depth 上限。它 fail closed 拒绝：

- traversal、absolute/drive path、NTFS ADS、Windows device alias、duplicate path、case collision；
- symlink、hardlink、reparse point、encrypted entry、未知压缩/entry type/容器；
- archive bomb、截断或结构冲突、嵌套容器 magic/扩展名不一致；
- `sourcesContent`、PDB、dSYM/debug 文件和可识别的绝对 build path。

ZIP 验证在解压前检查每项和流式累计预算；local-header 区必须被 central-directory 的一一对应记录完整、无缝覆盖，name/flags/method/CRC/size 必须一致。Unix file type 只接受 regular file/directory，祖先 file/directory 冲突也会失败。PE 必须有有效 DOS/PE/COFF/optional/section 结构；对原始 bytes 扫描路径和 debug 泄漏，因此 NUL 或无效 UTF-8 不能把泄漏藏起来。indexed source map 的每层 `sections[].map` 都递归检查 `sourcesContent`。

scan receipt 绑定被扫描 bytes 的 byte length 与 digest。manifest validator 会重新扫描传入的 published bytes，并同时比对 receipt、artifact digest 和 inventory，所以“扫描 A、发布 B”不能通过。SBOM 和 provenance 也是有长度与 digest 的真实 bytes；CycloneDX components 必须逐项绑定全部七包、外部依赖、artifact 和 inventory digest，空 components 不能自报 complete。第三方 notice 使用 strict JSON，版本/SPDX licenseId 必须与 SBOM 派生事实一致，完整 licenseText 的 byte length 与 SHA-256 还必须命中按组件版本维护的受控允许表，关键词空壳无效。升级外部组件时必须审阅新包的完整许可 bytes 与 SPDX ID，再显式更新 `name@version`、长度、digest 允许项及其回归 fixture，禁止自动沿用旧许可事实。该机器证据仍不替代法律审查。provenance document 的 subject 必须使用同一个 artifact path/digest。

## 现有 ArtifactRelease 的复用边界

`scripts/lib/ArtifactRelease` 的 ordinary-file、tree record、SHA-256、reparse 检查和原子目录发布设计可供后续流水线复用，但本合同没有修改它：

- `Read-ArtifactJsonObjectStrict` 仍调用 PowerShell `ConvertFrom-Json`；该命令不是 duplicate-key strict JSON parser，不能用于读取 ReleasePlan/ReleaseManifest。
- `New-ArtifactCanonicalZip` 固定 entry 顺序并回读校验内容，但没有固定 ZIP entry timestamp；名称里的 “Canonical” 不证明 byte-for-byte reproducibility。必须对签名/最终封装后的真实 ZIP bytes 重新 digest 和扫描。
- 根目录 MIT `LICENSE` 检查只证明仓库自身许可文件存在，不等于 third-party license/notice 合规。manifest 另要求完整 third-party package/dependency coverage 和有 digest 的 notice bytes。

## 纯验证 API 与测试

- `scripts/release/release-plan.mjs`：从 package manifest 生成/验证计划。
- `scripts/release/release-manifest.mjs`：验证最终 manifest、bytes 和 evidence。
- `scripts/release/artifact-scan.mjs`：受限递归扫描并生成 receipt。
- `scripts/release/strict-json.mjs`：拒绝重复 decoded key 的 JSON parser。

运行：

```bash
node --test scripts/tests/release-contract/*.test.mjs
```

这些 validator 是纯函数边界；fixture 中的文件读取只用于证明计划确实来自当前七包。它们不验证真实证书链、不执行 notarization/stapling、不生成 SBOM/provenance，也不消除扫描完成到外部发布之间的 TOCTOU。发布器仍必须持有同一不可变 byte handle，或在上传点重新验证 digest。
