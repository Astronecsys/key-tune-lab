# 参与开发

建议先阅读 README 中的架构边界。这个项目刻意保持无前端构建步骤，网页代码使用原生 ES modules 与 Canvas。

开发前运行：

```powershell
python -m pip install -e ".[dev]"
python -m ruff check src tests
python -m pytest
npm run check
npm test
```

提交新律制、音色、输入表面或映射预设时，优先添加 JSON 定义和对应测试。只有新增了一种真正不同的生成算法或映射算法时，才修改 Python 实现。

涉及音频回调的改动必须覆盖“持续音中加入/退出第二个音”和密集复音两类波形连续性测试。布局 schema 变更必须保留旧版本迁移路径。
