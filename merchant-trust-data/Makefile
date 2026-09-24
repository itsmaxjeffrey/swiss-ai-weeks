PY = .venv/bin/python

.PHONY: collect enrich build report test setup collect-external clean-external \
       update update-refresh weekly-on weekly-off weekly-status

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

# --- Reproducible fetch/update of ALL sources (see processing/update_all.py)

update:
	$(PY) -m processing.update_all

update-refresh:
	$(PY) -m processing.update_all --refresh-all

weekly-on:
	$(PY) -m processing.update_all --weekly on

weekly-off:
	$(PY) -m processing.update_all --weekly off

weekly-status:
	$(PY) -m processing.update_all --weekly status
