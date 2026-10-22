# Third-Party Notices

本仓库的 `weave-core`、`weave-cli`、`weave-templates` 的设计理念与部分实现
参考了以下开源项目。依据各自许可证，在此声明归属。

## JetBrains Mono + Nerd Fonts（随包发布的字体资源）

`@weavecode/server` 的 dashboard bundle（`web/dist/fonts/*.woff`）包含字体：

- **JetBrains Mono**（Version 2.304）— Copyright 2020 The JetBrains Mono
  Project Authors（<https://github.com/JetBrains/JetBrainsMono>），
  **SIL Open Font License 1.1**。修改：经 Nerd Fonts 3.4.0 打补丁 + 子集化，
  文件名改为 `WeaveNerdMono`（原 family 名 `JetBrainsMono NFM`）。JetBrains Mono
  未声明 Reserved Font Name，改名后仍受 OFL 1.1 约束、随包携带许可全文。
- **Nerd Fonts 3.4.0**（<https://github.com/ryanoasis/nerd-fonts>）补丁带入的
  图标字形来自多个符号集（Font Awesome Free、Material Design Icons、
  Octicons、Codicons、Weather Icons、Devicons 等），各符号集保留原许可
  （MIT / Apache 2.0 / SIL OFL / CC BY 4.0），权威清单见上游仓库。

许可全文与完整署名随字体一同发布：`web/dist/fonts/OFL.txt`、
`web/dist/fonts/ATTRIBUTION.md`。

## ruflo (claude-flow)

- **项目**：ruflo — Claude Code 编排框架（claude-flow v3.34.0）
- **来源**：<https://github.com/ruvnet/claude-flow>
- **许可证**：MIT License
- **版权**：Copyright (c) 2024-2026 ruvnet
- **借鉴范围**：
  - CLI 参数解析器设计（`parser.ts`）
  - 初始化执行流程（`init/executor.ts`）
  - settings / .mcp / CLAUDE.md / helpers 生成器结构
  - Zod 配置 schema 模式（`types.ts`）
  - 模板注册机制（`templates/index.ts`）

weave 是上述设计的 TypeScript 重新实现，未逐字复制 ruflo 源码；
如个别函数或结构与 ruflo 一致，依据 MIT 许可保留原作者版权声明。

### MIT License

```
MIT License

Copyright (c) 2024-2026 ruvnet

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Mermaid（dashboard 的 Markdown 图表渲染）

`@weavecode/server` 的 dashboard bundle 含 **mermaid 12.x**（按需动态加载的独立
chunk），用于渲染 Markdown 里的 ```mermaid 围栏。

- **项目**：mermaid — <https://github.com/mermaid-js/mermaid>
- **许可证**：MIT License
- **版权**：Copyright (c) 2014 - 2022 Knut Sveidqvist
- **改动**：无（仅随构建打包；初始化参数见 `web/src/components/ui/mermaid-block.tsx`）

mermaid 打包后内含其运行期依赖，许可各不相同，随包一并声明：

| 组件 | 许可证 | 版权/来源 |
| --- | --- | --- |
| elkjs（ELK 布局引擎） | **EPL-2.0** | Copyright (c) 2017 Kiel University and others — <https://github.com/kieler/elkjs> |
| chevrotain（语法解析） | **Apache-2.0** | <https://github.com/Chevrotain/chevrotain> |
| dompurify（HTML 消毒） | MPL-2.0 OR **Apache-2.0**（此处按 Apache-2.0 使用） | <https://github.com/cure53/DOMPurify> |
| d3 | ISC | Copyright 2010-2023 Mike Bostock |
| cytoscape、dagre-d3-es、marked、dayjs、katex、khroma、stylis、roughjs、uuid、ts-dedent、es-toolkit、@iconify/utils | MIT | 各自上游仓库 |
| cytoscape-fcose | MIT | <https://github.com/iVis-at-Bilkent/cytoscape.js-fcose> |

**ELK（EPL-2.0）特别声明**：weave **未修改** elkjs 源码，仅以未改动的形式随
dashboard bundle 分发；其完整源码可从上游仓库取得（上表链接），EPL-2.0 全文见
<https://www.eclipse.org/legal/epl-2.0/>。若需源码副本，请按该链接获取对应版本
（`pnpm why elkjs` 可查实际解析版本）。

**Apache-2.0（chevrotain / dompurify）**：保留其许可与 NOTICE 声明，全文见
<https://www.apache.org/licenses/LICENSE-2.0>。

### MIT License（mermaid）

```
Copyright (c) 2014 - 2022 Knut Sveidqvist

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
