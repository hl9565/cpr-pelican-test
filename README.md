# Pelican Test

Pelican Test is a community plugin for codex-proxy-rs (CPR). It runs a fixed-prompt benchmark for SVG pelican animations and records the output, timing, and token usage for comparison across runs. [CPR project](https://github.com/zyycn/codex-proxy-rs)

| Release | CPR plugin ID | Rust crate and binary |
| --- | --- | --- |
| `1.0.0` | `hl9565.pelican-test` | `cpr-pelican-test` |

## Install in CPR

1. In CPR's **Plugin Management**, select **GitHub**, enter `hl9565/cpr-pelican-test`, and select the `v1.0.0` release. For Linux x86_64, choose `hl9565.pelican-test-1.0.0-x86_64-unknown-linux-gnu.tar.gz` and leave download authentication set to none. [GitHub repository](https://github.com/hl9565/cpr-pelican-test) · [GitHub Releases](https://github.com/hl9565/cpr-pelican-test/releases)
2. For local upload, select **上传包** and choose the downloaded archive or a package you built in `dist/`. In either flow, check the version, target platform, and SHA-256 before installing.
3. Enable the instance and open **鹈鹕** from its management pages. The page uses existing CPR Client Keys and models.

## Compatibility / Migration

- Requires CPR `>=3.44.0, <4.0.0`, manifest schema 2, RPC protocol 7, `management` 2, and `maintenance` 1. The SDK and packaging CLI are pinned to CPR `v3.44.0` (revision `c622f085748f812936a7371fcc85d1621fa72ca8`).
- `hl9565.pelican-test` is the new independent plugin ID as of `v1.0.0`. If you used `selfhosted.omp-native-bridge` from `hl9565/codex-path-native-bridge`, install Pelican Test as a **new instance**. Existing history and schedules are scoped to the legacy instance.

## Run a benchmark

In **鹈鹕**, select an enabled Client Key, a model available to that key, and a reasoning effort (default `low`). Set **输出详略度** to `low`, `medium`, or `high` to send `text.verbosity`. The default (`auto`) omits it. Click **开始测试** to queue a single Responses request with this exact prompt.

```text
用svg绘制一个2D鹈鹏骑自行车的动画的html，不要用skill，不用测试
```

- **Background queue.** Manual and scheduled runs share one queue and execute one at a time. CPR continues processing after you close the page. Reopen the page to check progress in **后台运行队列**.
- **Cron schedules.** Open **定时测试** → **新增定时计划** to configure up to 10 independent plans per instance. Each plan has its own Client Key, model, effort, verbosity, five-field Cron rule, and IANA time zone. For example, `0 9 * * 1-5` with `Asia/Shanghai` runs at 09:00 on weekdays. You can pause, edit, or delete plans independently. A plan skips overlapping runs while its own job is queued or active.
- **Results and playback.** **生成记录** lists attempts newest first, 20 per page, with status, timing, token usage, and available key and routed account metadata. Click a thumbnail and confirm **打开链接** in CPR's dialog to play the full HTML and JavaScript in a new tab. On HTTP or when the host opener is unavailable, the page offers a short-lived link to copy.
- **Source and history.** Select **源码**, then **HTML 源码**, to inspect the result. The dialog also lets you copy the HTML. Opening a saved result uses no model request. Failed or incomplete attempts can retain partial source. When an archive limit prevents a save, the plugin reports the failure and preserves earlier records.

## Standalone mode

From the repository root, run with Node.js 22 or newer.

```sh
node scripts/serve-pelican.mjs
```

Open `http://127.0.0.1:3217/`. In **连接网关**, enter your gateway URL and model **API 密钥（Client Key）**. The page loads the model catalog through the local service. **开始测试** streams one manual Responses request. Click a thumbnail for an in-page preview, or use **HTML 源码**, copy, or download to access the generated HTML. History is stored in the current browser and origin. Reconnect after reloading.

## Privacy and key handling

- **CPR mode.** The plugin runs as a trusted process under the gateway's system identity. Install packages from sources you trust. The plugin uses the host bridge for model calls and reads non-secret Client Key metadata and routed account information. CPR handles account selection, access rules, quotas, and accounting. Hosted history is stored in PostgreSQL per plugin instance.
- **Standalone mode.** Use a Client Key scoped to the model API. The local server binds to loopback, checks Host and Origin, forwards only model-list and Responses requests to the selected gateway, and blocks redirects. It does not store or log the API key. Browser history stores a short key fingerprint. The preview runs inline scripts and styles in a sandbox with external networking blocked.

## Build and package

Use Rust/Cargo `1.99.1` or newer, Git, Make, and a toolchain for the CPR host's platform. Run from the repository root.

```sh
make cli
make package TARGET=x86_64-unknown-linux-gnu
```

`make cli` installs the pinned `cpr-plugin` CLI under `.tools/`. `make package` builds the `cpr-pelican-test` binary using the lockfile and packages it with the manifest and web page in `dist/`. Without `TARGET`, Make uses the Rust host tuple.

## Verification

```sh
node --test tests/pelican-page.test.mjs tests/pelican-server.test.mjs
RUSTFLAGS="-Dwarnings" cargo test --locked --offline
RUSTFLAGS="-Dwarnings" cargo check --locked --offline --all-targets
git diff --check
```

The Node tests use fixtures for the page, standalone loopback proxy, schedule controls, history, and playback link handling. Rust unit and process-level RPC tests cover registration, handshake rejection, the literal prompt and optional verbosity, draft completeness, preview callbacks, manual and scheduled queueing, Cron claim recovery, paginated and legacy history, archive quotas, and routed account matching. The offline Cargo commands require the pinned SDK and dependencies in the local Cargo cache.

## Changelog

### 1.0.0

- First independent CPR community release as `hl9565.pelican-test`.
- Includes the fixed-prompt benchmark, shared background queue, up to 10 Cron schedules, full-animation playback, and standalone mode.

See the standalone project's [GitHub Releases](https://github.com/hl9565/cpr-pelican-test/releases) for release notes and packages. The earlier HTTP path-bridge history through `0.3.12` is part of the forked baseline credited below.

## License

Licensed under the Apache License, Version 2.0. [Apache-2.0 license text](LICENSE)

This project builds on the Apache-2.0 forked baseline through version `0.3.12` and uses the Apache-2.0 CPR plugin SDK and its packaging CLI. Dependencies retain their respective licenses. Thanks to the maintainers and contributors. [ninthcj/codex-path-native-bridge](https://github.com/ninthcj/codex-path-native-bridge) · [zyycn/codex-proxy-rs plugin SDK](https://github.com/zyycn/codex-proxy-rs/blob/c622f085748f812936a7371fcc85d1621fa72ca8/backend/crates/gateway-plugin/sdk/README.md)
