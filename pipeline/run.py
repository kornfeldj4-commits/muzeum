#!/usr/bin/env python3
"""Muzeum daily data run. See README.md.

    python run.py                      # all 50 states + DC
    python run.py --states IL WI       # a few states
    python run.py --dry-run            # everything except writing the site data
"""
import sys

from muzeum_pipeline.pipeline import main

if __name__ == "__main__":
    sys.exit(main())
