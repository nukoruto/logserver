PYTHON ?= python
CONFIG ?= trainer/configs/default.yaml
SIMULINK_CONFIG ?= trainer/configs/simulink.yaml

.PHONY: preprocess train score threshold explain export-simulink tests lint

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
