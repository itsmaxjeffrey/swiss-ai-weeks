PY = .venv/bin/python

.PHONY: collect enrich build report test setup collect-external clean-external

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

# --- Phase-2 external datasets (see data/exports/external/EXTERNAL_QUALITY_REPORT.md)

SRC =

collect-external:
	ifeq ($(SRC),)
	$(PY) -m processing.collect_external
	else
	$(PY) -m collectors.$(SRC)
	endif

clean-external:
	ifeq ($(SRC),)
	$(PY) -m processing.clean_external
	else
	$(PY) -m processing.clean_external $(SRC)
	endif
