SHELL := /usr/bin/env bash

.DEFAULT_GOAL := help

.PHONY: help install dev dev-native dev-native-stop up down build lint typecheck test test-coverage smoke verify verify-dev \
	public-tree-scan docs-check release-guard internal-status fetch-internal docker-lint

help: ## Show available targets
	@awk 'BEGIN{FS=":.*##"} /^[a-zA-Z_-]+:.*##/{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install workspace dependencies
	pnpm install

dev: ## Bring up the dev stack in the foreground (Docker compose)
	pnpm run dev

dev-native: ## Start/restart the non-Docker dev stack (API 4301 + web 4300)
	bash scripts/dev-native.sh restart

dev-native-stop: ## Stop the non-Docker dev stack
	bash scripts/dev-native.sh stop

up: ## Bring up the dev stack detached
	pnpm run up

down: ## Tear down the dev stack
	pnpm run down

build: ## Build all packages via TypeScript project references
	pnpm run build

lint: ## Biome check + public-tree-scan + docs-check + release-guard (with its own tests)
	pnpm run lint

typecheck: ## Typecheck all packages
	pnpm run typecheck

test: ## Run the test suite
	pnpm run test

test-coverage: ## Run tests with coverage
	pnpm run test:coverage

smoke: build ## Boot the demo API and exercise its routes over HTTP
	bash scripts/smoke-api.sh

verify: ## lint + typecheck + test + build (what CI runs)
	pnpm run verify

verify-dev: ## verify + validate the dev compose config
	pnpm run verify-dev

public-tree-scan: ## Fail if private identifiers appear outside docs/internal
	bash scripts/public-tree-scan.sh

docs-check: ## Validate relative links in tracked docs
	bash scripts/docs-check.sh

release-guard: ## Fail if registry publishing was reintroduced
	bash scripts/release-guard.sh
	bash scripts/test-release-guard.sh

docker-lint: ## Lint Dockerfiles with droast
	droast apps/api/Dockerfile apps/web/Dockerfile

internal-status: ## Warn when the nested docs/internal repo has uncommitted work
	bash scripts/internal-status.sh

fetch-internal: ## Clone or update the maintainer-only companion repo into docs/internal
	bash scripts/fetch-internal.sh
