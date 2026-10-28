SHARED_PKG = $(ARTIFACTS_DIR)/nodejs/node_modules/@greenlove/shared

# Runtime deps are installed first: a later `npm install --prefix` would prune @greenlove/shared as extraneous.
build-SharedLayer:
	mkdir -p "$(ARTIFACTS_DIR)/nodejs"
	cp package.json "$(ARTIFACTS_DIR)/nodejs/package.json"
	npm install --prefix "$(ARTIFACTS_DIR)/nodejs" --omit=dev --no-package-lock
	npm install --no-package-lock
	node node_modules/typescript/lib/tsc.js -p tsconfig.json --outDir "$(SHARED_PKG)/dist"
	cp pkg/package.json "$(SHARED_PKG)/package.json"
