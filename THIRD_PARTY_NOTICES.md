# Third-Party Notices

本仓库的 `weave-core`、`weave-cli`、`weave-templates` 的设计理念与部分实现
参考了以下开源项目。依据各自许可证，在此声明归属。

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
