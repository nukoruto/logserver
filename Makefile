PYTHON=python
CONFIG?=configs/default.yaml

.PHONY: preprocess train score threshold explain export-simulink tests lint

preprocess:
`t$(PYTHON) -m scripts.preprocess --config $(CONFIG)

train:
`t$(PYTHON) -m scripts.train --config $(CONFIG)

score:
`t$(PYTHON) -m scripts.score --config $(CONFIG)

threshold:
`t$(PYTHON) -m scripts.threshold --config $(CONFIG)

explain:
`t$(PYTHON) -m scripts.explain --config $(CONFIG)

export-simulink:
`t$(PYTHON) -m scripts.export_simulink --config configs/simulink.yaml

tests:
`tpytest

lint:
`t$(PYTHON) -m ruff check src scripts tests
