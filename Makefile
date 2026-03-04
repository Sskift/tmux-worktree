.PHONY: build run publish

build:
	npm run build

run: build
	node dist/cli.js

publish:
	npm version patch
	npm run build
	npm publish --access public --registry=https://bnpm.byted.org
