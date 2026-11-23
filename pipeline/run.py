"""Run pipeline steps for configured sources.

    python -m pipeline.run                         # all sources, all steps
    python -m pipeline.run ccnd_2024 --steps prepare summaries
"""

import argparse

from pipeline import compare, export, prepare, summaries, tiles
from pipeline.lib import config

STEPS = {"prepare": prepare.run, "tiles": tiles.run, "summaries": summaries.run}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("sources", nargs="*", help="source ids (default: all in sources.yaml)")
    p.add_argument("--steps", nargs="+", choices=[*STEPS, "compare", "export"],
                   default=[*STEPS, "compare", "export"])
    args = p.parse_args()

    for source_id in args.sources or list(config.sources()):
        for step in args.steps:
            if step in STEPS:
                STEPS[step](source_id)
    if "compare" in args.steps:
        compare.run()
    if "export" in args.steps:
        export.run()


if __name__ == "__main__":
    main()
