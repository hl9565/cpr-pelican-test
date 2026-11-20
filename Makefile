TARGET ?= $(shell rustc --print host-tuple)
CPR_REV := c622f085748f812936a7371fcc85d1621fa72ca8
CLI := $(CURDIR)/.tools/bin/cpr-plugin

.PHONY: build test web-test serve cli package

build:
	cargo build --release --locked --target $(TARGET)

test:
	cargo test --locked

web-test:
	node --test tests/pelican-page.test.mjs tests/pelican-server.test.mjs

serve:
	node scripts/serve-pelican.mjs

cli:
	cargo install --git https://github.com/zyycn/codex-proxy-rs.git --rev $(CPR_REV) --locked --root $(CURDIR)/.tools codex-proxy-plugin-cli

package: build
	$(CLI) package --manifest $(CURDIR)/plugin.json --binary $(CURDIR)/target/$(TARGET)/release/cpr-pelican-test --target $(TARGET) --output-dir $(CURDIR)/dist
