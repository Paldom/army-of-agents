.PHONY: check validate lint evals test hooks app-check app-types app-web app-test serve supervisor

## check: run every quality gate (what CI runs)
check: validate lint evals test app-check

## validate: validate SKILL.md files, evals, security rules, and plugin manifests
validate:
	python3 scripts/validate_skills.py

## lint: ruff over the Python in this repo (config: ruff.toml)
#  uvx runs the pinned version with no local install; a PATH ruff is the fallback
#  and refuses to run if it is the wrong version (required-version in ruff.toml).
lint:
	@if command -v uvx >/dev/null 2>&1; then \
		uvx --from 'ruff==0.15.10' ruff check . && uvx --from 'ruff==0.15.10' ruff format --check .; \
	else \
		ruff check . && ruff format --check .; \
	fi

## evals: score every trigger case against every description (routing + ratchet)
#  --min-rank1 is the checked-in ratchet floor: raise it deliberately as the
#  number improves, never lower it to get green. Add the flag once the repo has
#  a few skills and a number worth defending.
evals:
	python3 scripts/run_evals.py

## test: self-checks for the scorer and the security rules
test:
	python3 scripts/test_run_evals.py
	python3 scripts/test_validate_skills.py

## hooks: install the commit-time layer (pre-commit + pre-push)
hooks:
	pre-commit install --install-hooks

## app-check: the bundled app must typecheck, parse and pass its tests
app-check: app-types app-web app-test

## app-types: strict TypeScript, no emit
app-types:
	cd app && npm run --silent typecheck

## app-web: the UI is a real TypeScript build now — typecheck, test, build
app-web:
	cd app/web && npm run --silent typecheck && npx vitest run --silent && npm run --silent build

## app-test: milestone proofs
app-test:
	cd app && npm test

## serve: run the workspace against a project
serve:
	cd app && npm run --silent serve

## supervisor: run the loop
supervisor:
	cd app && npm run --silent supervisor
