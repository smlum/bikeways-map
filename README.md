# bikeways-map

Web map for validating the Canadian Cycling Network Database (CCND) against lived experience.

## Data

- CCND 2024 — Statistics Canada
- CAN-BICS OSM 2024 — (phase 2)

## Setup

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Pipeline

```sh
python -m pipeline.run                    # all sources, all steps
python -m pipeline.run ccnd_2024 --steps prepare summaries
```

Config lives in `config/` (sources, classes, scope, tile settings).

## Structure

```
data/raw/<dataset>/<vintage>/   source downloads (gitignored)
data/build/                     processed outputs / PMTiles
config/                         YAML config
pipeline/                       data prep (prepare → tiles → summaries)
web/                            MapLibre app
```

## License

TBD
