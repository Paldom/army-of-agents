.PHONY: check validate app-check app-test app-types app-web serve supervisor

## check: run every quality gate (what CI runs)
check: validate app-check

## validate: validate all SKILL.md files, evals, and plugin manifests
validate:
	python3 scripts/validate_skills.py

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
