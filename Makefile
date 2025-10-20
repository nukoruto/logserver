PYTHON ?= python
CONFIG ?= trainer/configs/default.yaml
SIMULINK_CONFIG ?= trainer/configs/simulink.yaml

.PHONY: preprocess train score threshold explain export-simulink tests lint node-build audit-missing

preprocess:
	$(PYTHON) -m trainer.scripts.preprocess --config $(CONFIG)

train:
	$(PYTHON) -m trainer.scripts.train --config $(CONFIG)

score:
	$(PYTHON) -m trainer.scripts.score --config $(CONFIG)

threshold:
	$(PYTHON) -m trainer.scripts.threshold --config $(CONFIG)

explain:
	$(PYTHON) -m trainer.scripts.explain --config $(CONFIG)

export-simulink:
	$(PYTHON) -m trainer.scripts.export_simulink --config $(SIMULINK_CONFIG)

tests:
	pytest

lint:
	$(PYTHON) -m ruff check trainer/src trainer/scripts trainer/tests

node-build:
	pnpm --filter @logserver/session-splitter run build
	pnpm --filter @logserver/session-splitter-cli build
	pnpm --filter @logserver/dt-preproc build
	pnpm --filter @logserver/dt-anom build
	pnpm --filter @logserver/splitter-gui run build
	pnpm -r build

audit-missing:
	$(PYTHON) tools/audit_missing.py artifacts/latest/log.csv --output artifacts/latest/completeness.json
