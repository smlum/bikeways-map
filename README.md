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

## Structure

```
data/raw/<dataset>/<vintage>/   source downloads (gitignored)
data/build/                     processed outputs / PMTiles
pipeline/                       data prep scripts
web/                            MapLibre app
```

## License

TBD
