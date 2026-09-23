PY = .venv/bin/python

.PHONY: collect enrich build report test setup

setup:
	python3 -m venv .venv && .venv/bin/pip install -e . && .venv/bin/pip install pytest

collect:
	$(PY) -m processing.build_dataset collect

enrich:
	$(PY) -m processing.build_dataset enrich

build:
	$(PY) -m processing.build_dataset build

report:
	$(PY) -m processing.quality_report

test:
	$(PY) -m pytest -q
