.PHONY: build publish

build:
	npm run build

publish:
	npm version patch
	npm run build
	npm publish --access public --registry=https://bnpm.byted.org
