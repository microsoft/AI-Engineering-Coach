# Contributing to AI Engineer Coach

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## How to Contribute

1. **Fork** the repository and create your branch from `main`.
2. **Install dependencies**: `npm install`
3. **Build**: `npm run build`
4. **Run tests**: `npm test`
5. **Lint**: `npm run lint`
6. If you've added code, add tests that cover your changes.
7. Ensure the test suite passes and linting is clean.
8. Submit a **pull request**.

## Reporting Issues

Please use [GitHub Issues](https://github.com/microsoft/ai-engineer-coach/issues) to report bugs or
request features. Before filing a new issue, please check if one already exists.

## Security

If you discover a security vulnerability, please follow the instructions in [SECURITY.md](SECURITY.md).
**Do not** report security vulnerabilities through public GitHub issues.

## Creating Rules and Metrics

Detection rules and metrics are the primary extensibility surface of AI Engineer Coach. Each one is
a self-contained markdown file with YAML frontmatter and a small DSL — no code changes required to
ship a new one. Built-in rules live in [`src/core/rules/`](src/core/rules/) and metrics in
[`src/core/metrics/`](src/core/metrics/).

See [docs/AUTHORING_RULES.md](docs/AUTHORING_RULES.md) for the full authoring guide: file format,
annotated rule and metric examples, the local testing workflow, and links to the DSL reference.
