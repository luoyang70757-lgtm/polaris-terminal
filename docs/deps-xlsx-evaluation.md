# xlsx 依赖评估（高危依赖的可替代方案）

> 生成时间：2026-09-11。结论先行：**npm 上的 `xlsx` 线已无修复版本**（`npm audit` 报 `fixAvailable: false`），
> 所以"升级"这条路不存在；本文件给出三条有依据的替代路径与 PoC 结果。
> 本次**未改动** `package.json`（依赖变更需你确认后执行）。

## 一、用法面（小到可以整体替换）

| 位置 | 用途 |
|---|---|
| `main.js:53` → `lib/session-groups.js` | **写**：生成"主机导入模板"xlsx（2 个 sheet：主机列表 + 说明），仅用 `aoa_to_sheet` / `book_new` / `book_append_sheet` / `writeFile` |
| `src/renderer.js:3453-3455` | **读**：用户选的 Excel 第一张表 → 二维数组（`XLSX.read(buf)` + `sheet_to_json(sheet, { header: 1, defval: '' })`） |

即：**一处简单读、一处简单写**，没有公式/样式/图表/大表流式等高级能力依赖。

## 二、风险证据

`npm audit`（本机，2026-09-11）：

```
xlsx            high   via: Prototype Pollution in sheetJS / Regular Expression Denial of Service (ReDoS)
                       fixAvailable: false        ← npm 上无修复版本
@xmldom/xmldom  high   fixAvailable: true          ← 全部来自 electron-builder（devDependencies）
fast-uri        high   fixAvailable: true          ←   ├─ app-builder-lib → ajv → fast-uri
js-yaml         high   fixAvailable: true          ←   ├─ app-builder-lib / builder-util / dmg-builder
                                                   ←   └─ app-builder-lib → plist → @xmldom/xmldom
```

- 注册表现状：`npm view xlsx version` → **0.18.5**（dist-tags.latest 也是 0.18.5）；SheetJS 自 0.19 起**不再发 npm**，改在自家 CDN 发布（0.20.x 已修掉上述两个 advisory）。**这就是"不能只做无依据升级"的根据：npm 线到顶了。**
- 另 3 个 high **只在构建期**（electron-builder 链，不进 app 包），可直接 `npm audit fix` 处理，与运行时无关。
- 实际暴露面：只解析**用户自己选的** xlsx（无网络下载、无自动化批量解析）；ReDoS 影响的是解析卡顿，原型污染在渲染进程里更值得重视。

## 三、候选方案对比（含实测）

| 方案 | 代码改动 | 依赖/审计 | 风险 | 结论 |
|---|---|---|---|---|
| **A. 保持 0.18.5** | 无 | 0 依赖，2 个 high（不可修） | 解析恶意文件可原型污染/ReDoS | ❌ 已知高危且无修复路径 |
| **B. SheetJS 官方 CDN tarball 0.20.3** | **零**（API 完全一致：`read/sheet_to_json/aoa_to_sheet/writeFile`） | 仍 0 依赖；不在 npm registry → `npm audit` 追不到，需在文档/CI 说明 | 非 registry 依赖：`package.json` 记 URL，CI 需能访问 cdn.sheetjs.com（本机实测可达：HTTP/2 200） | ✅ **推荐（最小改动、直击 advisory）** |
| **C. 换 exceljs 4.4.0** | 读：`new ExcelJS.Workbook(); await wb.xlsx.readFile/load(buf); sheet.eachRow`；写：`addWorksheet/addRow/writeFile` | 实测**传递依赖 97 个**（archiver/unzipper/fast-csv/jszip…），自身树上有 **2 个 moderate**（可修） | 依赖面与体积明显变大；API 需重写两处 | ⚠️ 备选：若坚持 registry-only 依赖，选它 |
| **D. node-xlsx** | 小 | 包装 SheetJS → **同样的 advisory** | 无收益 | ❌ 不解决 |
| **E. 去掉 Excel：改 CSV/TSV 导入 + CSV 模板** | 读：自写 CSV 解析（约 20 行，需处理引号/逗号）；模板改 `.csv` | **零依赖** | 破坏现有"从 Excel 导入 / 下载 xlsx 模板"的使用习惯（为用户批量导入而做） | ⚠️ 可用但牺牲体验，建议只在彻底去依赖时考虑 |

## 四、PoC 实测（本机跑过，脚本在临时目录，不入库）

用**现库 xlsx@0.18.5** 与 **exceljs@4.4.0** 做双向交叉验证：

```
✓ ② exceljs 读现库写的文件:6 列 × 3 行全部一致(含中文/空格密码)
✓ ② sheet 名保持:主机列表
✓ ③ exceljs 造的模板(双 sheet)用现库读回一致:主机列表/说明, 行数 3
PoC 结果: 3 通过, 0 失败
```

迁移要点（PoC 踩到的坑，实施时必看）：
- **exceljs 的 `row.values` 是稀疏数组**（空单元格是"洞"），`.map()` 会跳过洞 → 必须 `Array.from(row.values)` 先实体化；单元格下标**从 1 开始**。
  现有导入代码 `String(c == null ? '' : c)` 对 `null/undefined` 已兼容，但迁移后要显式处理。
- 空单元格语义：现库 `defval: ''` 给空串，exceljs 给 `null`/洞 —— 保持"空串"归一化，`rowsToSessions` 的校验逻辑不变。

## 五、建议

1. **首选 B**：把 `package.json` 的 `"xlsx": "^0.18.5"` 换成 SheetJS 官方 tarball（`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`），**业务代码零改动**；在 README/CI 注明"非 registry 依赖，离线环境需自备缓存"，并把 `xlsx` 固定版本（不用 `^`）。
2. **若必须 registry-only**：选 C（exceljs），按 §四的两处改动迁移，并接受 97 个传递依赖；迁移后补一条回归：用现库生成的 xlsx 让新库读、新库生成的模板让现库读（PoC 已证明可行）。
3. **无论选哪个**：先跑 `npm audit fix`（不动 xlsx）修掉 devDeps 链上的 3 个 high；再补一条"导入含中文/空单元格/多 sheet 的 xlsx"回归。
4. 现成回归可复用：`docs/test-report-2026-08-25.md` 里的 Excel 导入链路 + `verify-toolbar.js`/导入相关脚本；建议新增一个只测"模板生成 → 读回 → 二维数组正确"的轻量 node 测试（不依赖 electron）。

---

## 六、实施结果（2026-09-11，按建议 1 执行 = 方案 B）

```
package.json  dependencies.xlsx = "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"  (精确锁定,不用 ^)
node_modules/xlsx → XLSX.version = 0.20.3 ; 依赖数 0 ; dist/xlsx.full.min.js 在位(渲染层脚本标签需要)
npm audit        → 受影响包:无(替换前:xlsx high ×2 + devDeps 3 个 high)
npm audit fix    → 修掉 electron-builder 链上 3 个 high(fast-uri/js-yaml/@xmldom/xmldom),electron-builder 仍 26.15.3
```

验证：`verify-xlsx-lib.js` **4/4**（① 主进程侧版本 0.20.3 ② 复刻 session-groups 的模板生成调用 → 双 sheet 正确
③ 渲染层 dist 在 Chromium/CSP 下可用且版本一致 ④ 渲染层读回主进程造的 .xlsx 成功）。

注意事项：
- **非 registry 依赖**：`npm ci`/CI 需能访问 `cdn.sheetjs.com`（本机实测 HTTP/2 200；GitHub Actions 为公网 runner，正常可访问）。离线环境需自备 npm 缓存。
- `npm audit` 不再跟踪它（不在 registry），后续跟进 SheetJS 版本需手动核对官方发布。
- 回滚：`git checkout package.json package-lock.json && npm ci`。

**打包验证（本机 `npm run dist`）**：构建成功产出 `release/mac/Polaris.app`（334MB，未签名属预期）；
`@electron/asar` 列表确认 **asar 内含 CDN 版 xlsx**（24 个文件，含渲染层要加载的 `dist/xlsx.full.min.js`
与主进程入口 `xlsx.js`）——非 registry 依赖在打包链路上无问题。
注：本机 `node_modules/.bin/*` 的可执行位曾被云同步剥掉（`Permission denied`），`chmod +x node_modules/.bin/*` 后正常，
与本次依赖变更无关。
